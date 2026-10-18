import { describe, expect, test } from "bun:test"
import { handbackOutput } from "./handback"
import { createSecretScanner, findPii, findSecret, redactPii, redactSecrets } from "./scrub"

const kinds = (text: string) => findPii(text).map((hit) => hit.kind)
const quotes = (text: string) => findPii(text).map((hit) => hit.quote)

describe("findPii", () => {
  test("an email", () => {
    expect(findPii("mail ada.lovelace+relay@example.co.uk today")).toEqual([{ kind: "email", quote: "ada.lovelace+relay@example.co.uk" }])
  })

  test("phones: E.164 and grouped numbers with separators", () => {
    expect(quotes("call +4915123456789 or +1 415 555 2671 or (030) 1234 5678")).toEqual(["+4915123456789", "+1 415 555 2671", "(030) 1234 5678"])
    expect(kinds("ring 0151-2345-6789")).toEqual(["phone"])
  })

  test("timestamps, dates, versions, ips, ids and plain counts are not phones", () => {
    for (const text of [
      "at 2026-10-17 12:30:45",
      "on 2026-10-17",
      "version 1.24.3.1009 of 10.0.0.12",
      "id 550e8400-e29b-41d4-a716-446655440000",
      "took 1697040000123 ms",
      "pid 12345 and 678",
      "msg_01HZX9 thr 42",
    ]) {
      expect(kinds(text)).toEqual([])
    }
  })

  test("an IBAN only when its mod-97 check holds", () => {
    expect(findPii("pay DE89 3704 0044 0532 0130 00 now")).toEqual([{ kind: "iban", quote: "DE89 3704 0044 0532 0130 00" }])
    expect(kinds("GB82WEST12345698765432")).toEqual(["iban"])
    expect(kinds("pay DE89 3704 0044 0532 0130 01 now")).toEqual([])
  })

  test("a card only when Luhn-valid with a card prefix", () => {
    expect(findPii("card 4111 1111 1111 1111 exp")).toEqual([{ kind: "card", quote: "4111 1111 1111 1111" }])
    expect(kinds("amex 3782-822463-10005")).toEqual(["card"])
    expect(kinds("card 4111 1111 1111 1112")).toEqual([])
    expect(kinds("1234567812345670")).toEqual([])
  })

  test("private-key and env-shaped paths", () => {
    expect(quotes("see ~/.ssh/id_ed25519 and /home/u/.aws/credentials")).toEqual(["~/.ssh/id_ed25519", "/home/u/.aws/credentials"])
    expect(quotes("cat ./certs/tls.key server.pem .env .env.local id_rsa")).toEqual(["./certs/tls.key", "server.pem", ".env", ".env.local", "id_rsa"])
    expect(kinds("process.env.HOME and config.api.key and id_rsa.pub")).toEqual([])
  })

  test("clean text has nothing", () => {
    expect(findPii("ship the relay judge after review; 3 files changed, 120 insertions")).toEqual([])
  })
})

test("redactPii replaces each hit with its kind", () => {
  expect(redactPii("mail a@b.io or +4915123456789 about .env")).toBe("mail [redacted email] or [redacted phone] about [redacted path]")
})

describe("private key blocks", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictG"

  test("the whole block goes, from BEGIN to END, and a BEGIN without an END to the end of the text", () => {
    for (const kind of ["PRIVATE KEY", "RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
      const text = `before\n-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----\nafter`
      expect(redactSecrets(text)).toBe("before\n[redacted private key]\nafter")
      expect(findSecret(text)).toBe("private key")
    }
    expect(redactSecrets(`a\n-----BEGIN PRIVATE KEY-----\n${body}`)).toBe("a\n[redacted private key]")
    expect(redactSecrets("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----")).toBe("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----")
    expect(redactSecrets(`-----BEGIN PRIVATE KEY----- ${body.replace("\n", " ")} -----END PRIVATE KEY----- token`)).toBe("[redacted private key] token")
  })

  test("a handback drops a block cut at its front up to its END, and redacts before it clips", () => {
    expect(handbackOutput(`${body}\n-----END RSA PRIVATE KEY-----\nresult ok`, true)).toBe("[earlier output cut]\nresult ok")
    expect(handbackOutput(`${body}\n-----END PRIVATE KEY-----\nresult ok`)).toBe("[earlier output cut]\nresult ok")
    const tail = handbackOutput(`-----BEGIN PRIVATE KEY-----\n${"A".repeat(5000)}\n-----END PRIVATE KEY-----\nok`)
    expect(tail).toBe("[redacted private key]\nok")
  })
})

describe("implementation tokens", () => {
  const grant = `krt_${"ab12".repeat(16)}`

  test("the default prefixes are scp_ and kre_, ahead of the generic kinds; a relay grant keeps its own kind", () => {
    expect(findSecret(`use scp_${"x9".repeat(10)} here`)).toBe("implementation token")
    expect(redactSecrets(`resume kre_${"0f".repeat(32)}`)).toBe("resume [redacted implementation token]")
    expect(findSecret(`export SCP_GRANT=${grant}`)).toBe("relay grant")
    expect(findSecret("acme_0123456789abcdef0123")).toBeNull()
  })

  test("a scanner takes its own prefixes, with or without the underscore, and refuses a prefix that is not alphanumeric", () => {
    const scanner = createSecretScanner(["acme", "acr_"])
    expect(scanner.findSecret("acme_0123456789abcdef0123")).toBe("implementation token")
    expect(scanner.redactSecrets("a acr_0123456789abcdef0123 b")).toBe("a [redacted implementation token] b")
    expect(scanner.findSecret(`scp_${"x9".repeat(10)}`)).toBeNull()
    expect(createSecretScanner([]).findSecret(grant)).toBe("relay grant")
    expect(() => createSecretScanner(["a|b"])).toThrow("invalid token prefix")
  })
})
