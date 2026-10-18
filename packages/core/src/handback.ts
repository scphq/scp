import { LIMITS } from "./protocol"
import { stripControl } from "./render"
import { afterCutKey, redactSecrets } from "./scrub"

/** OSC, DCS/PM/APC strings, CSI (7 and 8 bit) and the other escape sequences a terminal reads */
const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[P^_][^\u001b]*(?:\u001b\\)?|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g
/** what stands where a handback lost earlier output, on its own line */
export const HANDBACK_CUT = "[earlier output cut]"

/**
 * clean text's last `bytes` bytes: all of it when it fits and nothing was `dropped`, else from the first line that starts in reach (a
 * character boundary when one line is longer than that) behind {@link HANDBACK_CUT} on its own line, when the cap has room for it
 */
export function keepLast(text: string, bytes: number, dropped = false): string {
  const encoded = new TextEncoder().encode(text)
  if (!text || (!dropped && encoded.length <= bytes)) return text
  const mark = bytes > HANDBACK_CUT.length + 1 ? `${HANDBACK_CUT}\n` : ""
  let start = Math.max(0, encoded.length - (bytes - mark.length))
  const nl = start > 0 && encoded[start - 1] !== 0x0a ? encoded.indexOf(0x0a, start) : -1
  if (nl !== -1 && nl + 1 < encoded.length) start = nl + 1
  while (start > 0 && start < encoded.length - 1 && encoded[start] === 0x0a) start++
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++
  return `${mark}${new TextDecoder().decode(encoded.subarray(start))}`
}

/**
 * a harness's last output as its handback carries it: escape sequences and control characters out, each line as a carriage return leaves it,
 * the rest of a private key whose start was cut off dropped and every credential redacted, then {@link keepLast} within `bytes`. `cut` says
 * the text already lost its start, whose partial first line goes too
 */
export function handbackOutput(text: string, cut = false, bytes: number = LIMITS.handbackBytes): string {
  const whole = cut && text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text
  const lines = whole
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => {
      const shown = line.replace(/\r+$/, "")
      return shown.slice(shown.lastIndexOf("\r") + 1)
    })
  const shown = stripControl(lines.join("\n"))
  const rest = afterCutKey(shown)
  return keepLast(redactSecrets(rest ?? shown).trim(), bytes, cut || rest !== null)
}
