const ENCODER = new TextEncoder()

/** the UTF-8 byte length of text, the unit every byte limit counts in */
export function utf8Bytes(text: string): number {
  return ENCODER.encode(text).length
}
