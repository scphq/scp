/** the longest request line the broker reads, in bytes */
export const MAX_LINE = 256 * 1024

const NEWLINE = 0x0a
const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** splits a byte stream into UTF-8 lines; a multibyte character split across chunks stays whole */
export class LineReader {
  private pending: Buffer = Buffer.alloc(0)

  constructor(private readonly maxBytes: number) {}

  /** bytes of a line that has not ended yet */
  get buffered(): number {
    return this.pending.length
  }

  /** the complete lines so far; `tooLong` once a line passes the cap (lines before it still count) */
  push(chunk: Uint8Array): { lines: string[]; tooLong: boolean } {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk)
    const lines: string[] = []
    for (let newline = this.pending.indexOf(NEWLINE); newline !== -1; newline = this.pending.indexOf(NEWLINE)) {
      if (newline > this.maxBytes) return { lines, tooLong: true }
      const line = decoder.decode(this.pending.subarray(0, newline))
      this.pending = this.pending.subarray(newline + 1)
      if (line.trim()) lines.push(line)
    }
    return { lines, tooLong: this.pending.length > this.maxBytes }
  }
}

const BATCH = 64 * 1024

/** queues lines as a list of chunks and writes as much as the socket takes, the rest on drain */
export class LineWriter {
  private chunks: Uint8Array[] = []
  private static readonly EMPTY = new Uint8Array(0)
  private head = 0
  private queued = 0

  /** bytes waiting for the socket */
  get pending(): number {
    return this.queued
  }

  push(value: unknown): void {
    this.pushBytes(encodeLine(value))
  }

  pushBytes(line: Uint8Array): void {
    this.chunks.push(line)
    this.queued += line.length
  }

  flush(write: (bytes: Uint8Array) => number): void {
    while (this.queued) {
      const first = this.chunks[this.head]!
      let batch: Uint8Array = first
      if (first.length < BATCH && this.head + 1 < this.chunks.length) {
        const parts: Uint8Array[] = []
        let size = 0
        for (let i = this.head; i < this.chunks.length && size < BATCH; i++) {
          parts.push(this.chunks[i]!)
          size += this.chunks[i]!.length
        }
        batch = Buffer.concat(parts, size)
      }
      const written = write(batch)
      if (written <= 0) return
      this.consume(written)
    }
  }

  private consume(bytes: number): void {
    this.queued -= bytes
    while (bytes > 0) {
      const first = this.chunks[this.head]!
      if (bytes < first.length) {
        this.chunks[this.head] = first.subarray(bytes)
        break
      }
      bytes -= first.length
      this.chunks[this.head++] = LineWriter.EMPTY
    }
    if (this.head > 1024 || this.head === this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }
}

export function encodeLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`)
}
