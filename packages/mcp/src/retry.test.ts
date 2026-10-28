import { expect, test } from "bun:test"
import { RelayError } from "@scp-dev/core"
import { channelRetryMs } from "./server"

test("a refused claim backs the channel poll off up to five minutes; other failures keep their pause", () => {
  const refused = new RelayError("unauthorized", "grant refused: grant invalid")
  expect([0, 1, 2, 3].map((n) => channelRetryMs(refused, n))).toEqual([5000, 10_000, 20_000, 40_000])
  expect(channelRetryMs(refused, 10)).toBe(300_000)
  expect(channelRetryMs(refused, 10_000)).toBe(300_000)
  expect(channelRetryMs(new RelayError("unavailable", "down"), 10)).toBe(5000)
  expect(channelRetryMs(new Error("socket closed"), 10)).toBe(1000)
})
