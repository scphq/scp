const KEY_KIND = String.raw`[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`
const KEY_END = new RegExp(String.raw`-----END ${KEY_KIND}[^\n]*\n?`)

/** the prefixes, without their `_`, of the tokens this implementation issues: `kre_` resume tokens and `scp_` */
export const DEFAULT_IMPLEMENTATION_PREFIXES: readonly string[] = ["scp", "kre"]

const PREFIX = /^[A-Za-z0-9]{1,32}$/

const GENERIC: [string, RegExp][] = [
  ["relay grant", /\bkrt_[0-9a-f]{64}\b/],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["api key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["aws key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private key", new RegExp(String.raw`-----BEGIN ${KEY_KIND}[\s\S]*?(?:-----END ${KEY_KIND}|$)`)],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ["bearer token", /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["aws secret", /aws[_-]?secret[_-]?(?:access[_-]?)?key["']?\s*[:=]\s*["']?[A-Za-z0-9+/]{40}/i],
  ["assigned secret", /(?<![A-Za-z])(?:api[_-]?key|token|secret|password|passwd|credentials?)(?![A-Za-z])["']?\s*[:=]\s*["']?(?=[A-Za-z0-9+/._~-]*[0-9])(?=[A-Za-z0-9+/._~-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9+/._~-]{19,}/i],
]

export interface SecretScanner {
  /** the kind of credential the text carries, or null; defence in depth, never a confidentiality boundary */
  findSecret(text: string): string | null
  /** the text with every credential match replaced by `[redacted <kind>]` */
  redactSecrets(text: string): string
}

/** a scanner whose `implementation token` kind matches `<prefix>_` and at least 16 of `[A-Za-z0-9_-]` for each of `prefixes`, ahead of the generic kinds */
export function createSecretScanner(prefixes: readonly string[] = DEFAULT_IMPLEMENTATION_PREFIXES): SecretScanner {
  const names = prefixes.map((prefix) => prefix.replace(/_$/, ""))
  for (const name of names) if (!PREFIX.test(name)) throw new Error(`invalid token prefix: ${name}`)
  const patterns: [string, RegExp][] = names.length ? [["implementation token", new RegExp(String.raw`\b(?:${names.join("|")})_[A-Za-z0-9_-]{16,}`)], ...GENERIC] : [...GENERIC]
  const global = patterns.map(([name, pattern]) => [name, new RegExp(pattern.source, `${pattern.flags}g`)] as const)
  return {
    findSecret(text) {
      for (const [name, pattern] of patterns) if (pattern.test(text)) return name
      return null
    },
    redactSecrets(text) {
      let out = text
      for (const [name, pattern] of global) out = out.replace(pattern, `[redacted ${name}]`)
      return out
    },
  }
}

let scanner = createSecretScanner()

/** sets the prefixes {@link findSecret} and {@link redactSecrets} report as `implementation token`, in place of {@link DEFAULT_IMPLEMENTATION_PREFIXES} */
export function setImplementationPrefixes(prefixes: readonly string[]): void {
  scanner = createSecretScanner(prefixes)
}

/** the kind of credential the text carries, or null; defence in depth, never a confidentiality boundary */
export function findSecret(text: string): string | null {
  return scanner.findSecret(text)
}

/** the text after the END of a private key block whose BEGIN it lacks, a block cut at the front; null when it has no such END */
export function afterCutKey(text: string): string | null {
  const end = KEY_END.exec(text)
  if (!end || text.slice(0, end.index).includes("-----BEGIN ")) return null
  return text.slice(end.index + end[0].length)
}

/** the text with every credential match replaced */
export function redactSecrets(text: string): string {
  return scanner.redactSecrets(text)
}

export interface PiiHit {
  kind: string
  quote: string
}

const KEY_PATH = new RegExp(
  [
    String.raw`(?<=^|[\s"'\x60(<\[=:,])(?:~?[\w.-]*\/)*(?:id_(?:rsa|ed25519|ecdsa|dsa)(?![\w.])|[\w-][\w.-]*\.pem(?![\w.])|\.env(?:\.[\w-]+)*(?![\w\/.])|\.aws\/credentials(?!\w)|\.ssh\/[\w.\/-]*)`,
    String.raw`(?<=^|[\s"'\x60(<\[=:,])(?:~?[\w.-]*\/)+[\w-][\w.-]*\.key(?![\w.])`,
  ].join("|"),
  "g",
)
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g
const CARD = /(?<![\d+])(?:\d[ -]?){12,18}\d(?!\d)/g
const PHONE = /(?<![\w+.\/-])(?:\+\d{8,15}(?![\w.\/:-])|(?:\+\d{1,3}[ -]?)?(?:\(\d{1,4}\)[ -]?)?\d{2,5}(?:[ -]\d{2,5}){1,5}(?![\w\/:-]|\.\d))/g

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/ /g, "")
  if (iban.length < 15 || iban.length > 34) return false
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))
  let rest = 0
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97
  return rest === 1
}

function luhnCard(raw: string): boolean {
  const digits = raw.replace(/[ -]/g, "")
  if (digits.length < 13 || digits.length > 19 || !/^[2-6]/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

function phoneShaped(raw: string): boolean {
  const digits = raw.replace(/\D/g, "").length
  return digits >= 9 && digits <= 15 && !/^\d{4}-\d{2}-\d{2}(?:\D|$)/.test(raw)
}

const PII: [string, RegExp, (quote: string) => boolean][] = [
  ["path", KEY_PATH, () => true],
  ["email", EMAIL, () => true],
  ["iban", IBAN, ibanValid],
  ["card", CARD, luhnCard],
  ["phone", PHONE, phoneShaped],
]

function piiSpans(text: string): (PiiHit & { at: number })[] {
  const hits: (PiiHit & { at: number })[] = []
  for (const [kind, pattern, valid] of PII) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index
      const end = at + match[0].length
      if (!valid(match[0]) || hits.some((hit) => at < hit.at + hit.quote.length && hit.at < end)) continue
      hits.push({ kind, quote: match[0], at })
    }
  }
  return hits.sort((a, b) => a.at - b.at)
}

/** personal data the text carries, in order: emails, phones, IBANs, Luhn-valid cards and private-key or env-shaped paths; deterministic, best effort */
export function findPii(text: string): PiiHit[] {
  return piiSpans(text).map(({ kind, quote }) => ({ kind, quote }))
}

/** the text with every findPii hit replaced by `[redacted <kind>]` */
export function redactPii(text: string): string {
  let out = text
  for (const hit of piiSpans(text).reverse()) out = `${out.slice(0, hit.at)}[redacted ${hit.kind}]${out.slice(hit.at + hit.quote.length)}`
  return out
}
