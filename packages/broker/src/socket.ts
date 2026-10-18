import type { Socket } from "node:net"

export interface ConnHandlers<T> {
  data(conn: Conn<T>, chunk: Buffer): void
  drain(conn: Conn<T>): void
  close(conn: Conn<T>, error?: Error): void
}

/** how long an ended connection waits for its peer to close before it is cut */
const END_GRACE_MS = 2000

/** a unix socket connection with per-connection state, writing through LineWriter's partial-write contract */
export class Conn<T> {
  private ending = false

  constructor(
    readonly socket: Socket,
    public data: T,
    handlers: ConnHandlers<T>,
  ) {
    socket.on("data", (chunk: Buffer) => {
      if (!this.ending) handlers.data(this, chunk)
    })
    socket.on("drain", () => handlers.drain(this))
    socket.on("error", (error) => handlers.close(this, error))
    socket.on("close", () => handlers.close(this))
  }

  /** bytes the socket took but has not sent yet */
  get unsent(): number {
    return this.socket.writableLength
  }

  /** takes all of `bytes`, or none while the socket waits to drain */
  write(bytes: Uint8Array): number {
    if (this.ending || this.socket.destroyed || this.socket.writableNeedDrain) return 0
    this.socket.write(bytes)
    return bytes.length
  }

  /** sends what was written, then closes once the peer does, or after a grace period; what the peer still sends is discarded */
  end(): void {
    if (this.ending || this.socket.destroyed) return
    this.ending = true
    this.socket.resume()
    this.socket.end()
    setTimeout(() => this.socket.destroy(), END_GRACE_MS).unref()
  }

  pause(): void {
    if (!this.ending) this.socket.pause()
  }

  resume(): void {
    this.socket.resume()
  }
}
