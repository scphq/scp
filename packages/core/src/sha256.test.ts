import { expect, test } from "bun:test"
import { sha256Hex } from "./sha256"

const reference = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

test("matches Bun.CryptoHasher on empty, ASCII, multi-byte and long inputs", () => {
  const inputs = [
    "",
    "abc",
    "hello world",
    "größe 日本語 🙂 ü",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(63),
    "x".repeat(64),
    "x".repeat(65),
    "the quick brown fox jumps over the lazy dog, ".repeat(40),
    "é".repeat(1000),
  ]
  for (const input of inputs) expect(sha256Hex(input)).toBe(reference(input))
})

test("known vector", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})
