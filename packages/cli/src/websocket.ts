import { createHash, randomBytes } from "node:crypto"
import type { Socket } from "node:net"

export interface Upgrade {
  path?: string
  host?: string
  headers?: Record<string, string>
}

/** a WebSocket client on a connected socket: the HTTP upgrade, masked text frames out, text frames in, pings answered */
export class WebSocketLink {
  private buffer: Buffer = Buffer.alloc(0)
  private opened = false
  private fragments: Buffer[] = []
  private key = randomBytes(16).toString("base64")
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve
    this.rejectReady = reject
  })
  private closed: Error | undefined

  /** `name` prefixes the errors; `onClose` runs once, with the error that ended the link */
  constructor(
    private socket: Socket,
    upgrade: Upgrade,
    private name: string,
    private onText: (text: string) => void,
    private onClose: (error: Error) => void = () => {},
  ) {
    this.ready.catch(() => {})
    const headers = Object.entries(upgrade.headers ?? {})
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join("")
    socket.on("connect", () => {
      socket.write(
        `GET ${upgrade.path ?? "/"} HTTP/1.1\r\nHost: ${upgrade.host ?? "localhost"}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`,
      )
    })
    socket.on("data", (data) => {
      try {
        this.feed(typeof data === "string" ? Buffer.from(data) : data)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on("error", (error) => this.fail(error))
    socket.on("close", () => this.fail(new Error(`${name} socket closed`)))
  }

  get destroyed(): boolean {
    return this.closed !== undefined || this.socket.destroyed
  }

  fail(error: Error): void {
    this.rejectReady(error)
    this.socket.destroy()
    if (this.closed) return
    this.closed = error
    this.onClose(error)
  }

  private feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])
    if (!this.opened) {
      const end = this.buffer.indexOf("\r\n\r\n")
      if (end < 0) return
      const header = this.buffer.subarray(0, end).toString()
      const accept = createHash("sha1").update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
      if (!/^HTTP\/1\.1 101\b/.test(header) || !header.toLowerCase().includes(`sec-websocket-accept: ${accept}`.toLowerCase()))
        throw new Error(`${this.name} WebSocket upgrade failed${/^HTTP\/1\.1 \d+.*/.test(header) ? ` (${header.split("\r\n")[0]!.slice(9)})` : ""}`)
      this.buffer = this.buffer.subarray(end + 4)
      this.opened = true
      this.resolveReady()
    }
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0]! & 15
      const final = (this.buffer[0]! & 128) !== 0
      const masked = (this.buffer[1]! & 128) !== 0
      let length = this.buffer[1]! & 127
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const size = this.buffer.readBigUInt64BE(2)
        if (size > 64n * 1024n * 1024n) throw new Error(`${this.name} WebSocket frame too large`)
        length = Number(size)
        offset = 10
      }
      const start = offset + (masked ? 4 : 0)
      if (this.buffer.length < start + length) return
      const payload = Buffer.from(this.buffer.subarray(start, start + length))
      if (masked) for (let i = 0; i < length; i++) payload[i] = payload[i]! ^ this.buffer[offset + (i % 4)]!
      this.buffer = this.buffer.subarray(start + length)
      if (opcode === 8) {
        this.fail(new Error(`${this.name} WebSocket closed`))
        return
      }
      if (opcode === 9) this.frame(10, payload)
      if (opcode !== 1 && opcode !== 0) continue
      this.fragments.push(payload)
      if (!final) continue
      const text = Buffer.concat(this.fragments).toString()
      this.fragments = []
      this.onText(text)
    }
  }

  private frame(opcode: number, payload: Buffer): void {
    const length = payload.length
    const header = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10)
    header[0] = 128 | opcode
    header[1] = 128 | (length < 126 ? length : length < 65536 ? 126 : 127)
    if (header.length === 4) header.writeUInt16BE(length, 2)
    if (header.length === 10) header.writeBigUInt64BE(BigInt(length), 2)
    const mask = randomBytes(4)
    const body = Buffer.from(payload)
    for (let i = 0; i < length; i++) body[i] = body[i]! ^ mask[i % 4]!
    this.socket.write(Buffer.concat([header, mask, body]))
  }

  send(text: string): void {
    if (this.destroyed) throw new Error(`${this.name} socket closed`)
    this.frame(1, Buffer.from(text))
  }
}
