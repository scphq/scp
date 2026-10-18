import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bearer, Browser, codeOf, DUMMY_TOKEN, type Relay, startRelay, TURNSTILE_FAIL } from "./harness";

let relay: Relay;

beforeAll(async () => {
  relay = await startRelay();
}, 30_000);

afterAll(async () => {
  await relay?.dispose();
});

describe("skeleton", () => {
  test("health answers", async () => {
    const res = await relay.fetch("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "scp-relay" });
  });
});
