import { LIMITS, type PeekLevel } from "./protocol"
import { PREAMBLE, stripControl, stripSteerNote } from "./render"
import { redactSecrets } from "./scrub"

export const PEEK = {
  ring: 20,
  storeChars: 2000,
  turnChars: 600,
  fullChars: 2000,
  totalBytes: 8 * 1024,
  turnsDefault: 3,
  turnsMax: 10,
  pairPerMinute: 6,
  targetPerHour: 60,
  whoKeep: 50,
  stateKeep: 5,
  toolsKeep: 20,
  rawChars: LIMITS.bodyBytes,
  quoteChars: 40,
  quoteBodies: 50,
  quoteHits: 8,
} as const

export const OMITTED = "[relay message omitted]"

const OPEN = /<relay-message\b/i
const CLOSE = /<\/relay-message\s*>/i
/** a channel push from the relay's MCP server, or any channel tag naming a sender and thread */
const CHANNEL_OPEN = /<channel\b(?=[^>]*\bsource\s*=\s*["']?scp\b|(?=[^>]*\bfrom\s*=)(?=[^>]*\bthread\s*=))[^>]*>/i
const CHANNEL_CLOSE = /<\/channel\s*>/i
const MARKER = /\[redacted [a-z ]+\]|\[relay message omitted\]/g

/**
 * the text with every relay-message span and relay channel wrapper, an unterminated opening to the end, an orphan relay-message closing from
 * the start, and the preamble cut to {@link OMITTED}
 */
export function stripRelaySpans(text: string): string {
  let rest = text.split(PREAMBLE).join(OMITTED)
  let out = ""
  for (;;) {
    const open = rest.search(OPEN)
    const close = rest.search(CLOSE)
    const channel = rest.search(CHANNEL_OPEN)
    const first = Math.min(...[open, close, channel].map((at) => (at === -1 ? Infinity : at)))
    if (first === Infinity) return out + rest
    if (first === close) {
      out += OMITTED
      rest = rest.slice(close + rest.slice(close).match(CLOSE)![0].length)
      continue
    }
    const until = first === channel ? CHANNEL_CLOSE : CLOSE
    out += rest.slice(0, first) + OMITTED
    const after = rest.slice(first)
    const end = after.search(until)
    if (end === -1) return out
    rest = after.slice(end + after.slice(end).match(until)![0].length)
  }
}

/** the text with every run of at least {@link PEEK.quoteChars} characters that also appears in one of `bodies` cut to {@link OMITTED} */
export function dropQuoted(text: string, bodies: readonly string[]): string {
  const block = PEEK.quoteChars / 2
  const index = new Map<string, [string, number][]>()
  for (const body of bodies) {
    for (let at = 0; at + block <= body.length; at += block) {
      const key = body.slice(at, at + block)
      const hits = index.get(key) ?? []
      if (hits.length < PEEK.quoteHits) hits.push([body, at])
      index.set(key, hits)
    }
  }
  const cuts: [number, number][] = []
  for (let i = 0; i + block <= text.length; i++) {
    if (cuts.length && i + block <= cuts.at(-1)![1]) continue
    for (const [body, at] of index.get(text.slice(i, i + block)) ?? []) {
      let start = 0
      while (i - start > 0 && at - start > 0 && text[i - start - 1] === body[at - start - 1]) start++
      let end = block
      while (i + end < text.length && at + end < body.length && text[i + end] === body[at + end]) end++
      if (start + end < PEEK.quoteChars) continue
      const last = cuts.at(-1)
      if (last && i - start <= last[1]) last[1] = Math.max(last[1], i + end)
      else cuts.push([i - start, i + end])
      break
    }
  }
  let out = ""
  let from = 0
  for (const [start, end] of cuts) {
    out += text.slice(from, start) + OMITTED
    from = end
  }
  return out + text.slice(from)
}

/**
 * at most `max` characters, cut back to a word boundary and never inside a `[redacted X]` or {@link OMITTED} marker, with `...` when cut
 */
export function clip(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false }
  const markers = [...text.matchAll(MARKER)].map((m) => [m.index!, m.index! + m[0].length] as const)
  let end = max - 3
  for (const [start, stop] of markers) if (start < end && stop > end) end = start
  const boundary = Math.max(text.lastIndexOf(" ", end), text.lastIndexOf("\n", end))
  if (boundary > end / 2) {
    end = boundary
    for (const [start, stop] of markers) if (start < end && stop > end) end = stop
  }
  return { text: `${text.slice(0, end).trimEnd()}...`, cut: true }
}

/**
 * a turn's text as stored: a spawn's prompt note, relay spans and quotes of `delivered` bodies cut, credentials redacted, control characters removed, and only then
 * capped at a word boundary, so a cut never keeps part of a credential
 */
export function digestText(raw: string, delivered: readonly string[] = []): string {
  const text = stripRelaySpans(stripControl(stripSteerNote(raw).slice(0, PEEK.rawChars)))
  return clip(redactSecrets(dropQuoted(text, delivered.map(stripControl))), PEEK.storeChars).text
}

/** a stored turn's text as read: scrubbed again, then cut to `max` */
export function readText(stored: string, max: number): { text: string; cut: boolean } {
  return clip(redactSecrets(stripRelaySpans(stripControl(stored))), max)
}

/** the level a `peek_set` names: `on` and `local` are local, `off` is none */
export function peekLevel(value: unknown): PeekLevel | null | undefined {
  if (value === "on" || value === "local") return "local"
  if (value === "off") return null
  return undefined
}

