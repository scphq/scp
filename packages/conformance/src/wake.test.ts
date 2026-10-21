import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { MachineWakeEvent } from "@scp-dev/hub";
import { forward, scenario, view } from "./scenarios";
import { enabled, targetNames, waitFor } from "./targets";

function receiver(decline = false) {
  const calls: { method: string; headers: Headers; body: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({ method: request.method, headers: request.headers, body: await request.text() });
      return decline ? Response.json({ declined: "paused" }, { status: 403 }) : new Response(null, { status: 204 });
    },
  });
  return { calls, url: `http://127.0.0.1:${server.port}/wake`, stop: () => server.stop(true) };
}
const secret = "conformance-wake-secret";
const hibernated = () => view("target", { presence: "hibernated", wake: "hook:spawn" });
const quiet = async (calls: unknown[]) => {
  const deadline = Date.now() + 200;
  await waitFor(() => {
    expect(calls).toHaveLength(1);
    return Date.now() >= deadline;
  }, "wake remains debounced");
};

describe.each(targetNames)("%s machine wake conformance", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  test("hibernated delivery posts signed metadata once, marks waking and debounces", async () => {
    const http = receiver();
    try {
      await scenario(name, async ({ bridge }) => {
        const sink = await bridge("acme", "sleeping");
        expect(await sink.result("machine_wake", { url: http.url, secret })).toEqual({ set: true });
        await sink.result("mirror", { endpoints: [hibernated()], full: true });
        await sink.close();
        const source = await bridge("acme", "alpha", [view("source")]);
        const sent = await forward(source, "sleeping/target", { body: "body must stay private" });
        const call = await waitFor(() => http.calls[0], "wake POST", 2000);
        expect(call.method).toBe("POST");
        expect(call.headers.get("content-type")).toBe("application/json");
        const timestamp = call.headers.get("x-scp-timestamp")!;
        expect(Math.abs(Number(timestamp) - Date.now())).toBeLessThan(5000);
        expect(call.headers.get("x-scp-signature")).toBe(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${call.body}`).digest("hex")}`);
        const event = JSON.parse(call.body) as MachineWakeEvent;
        expect(structuredClone(event)).toEqual({
          scp: 1,
          event: "machine_wake",
          account: "acme",
          machine: "sleeping",
          endpoints: ["acme/sleeping/target"],
          message: { id: sent.id, from: "acme/alpha/source", kind: "message", thread: sent.thread, created_at: expect.any(String) },
          from_account: "acme",
          same_account: true,
        });
        expect(Number.isFinite(Date.parse(event.message.created_at))).toBe(true);
        expect(call.body).not.toContain("body must stay private");
        expect(call.body).not.toContain(secret);
        await waitFor(
          async () =>
            (await source.result<{ endpoints: { address: string; waking?: boolean; presence: string }[] }>("list", { all: true })).endpoints.find(
              (e) => e.address === "acme/sleeping/target" && e.waking && e.presence === "hibernated",
            ),
          "waking row",
        );
        await forward(source, "sleeping/target", { body: "second" });
        await quiet(http.calls);
      });
    } finally {
      await http.stop();
    }
  });
  test("a 403 decline holds further wakes from the same sender", async () => {
    const http = receiver(true);
    try {
      await scenario(
        name,
        async ({ bridge, connect }) => {
          const sink = await bridge("acme", "sleeping");
          await sink.result("machine_wake", { url: http.url, secret });
          await sink.result("mirror", { endpoints: [hibernated()], full: true });
          await sink.close();
          const source = await bridge("acme", "alpha", [view("source")]);
          await forward(source, "sleeping/target");
          await waitFor(() => http.calls[0], "declined wake", 2000);
          const observer = await connect();
          await observer.hello({ observe: true });
          await waitFor(
            async () =>
              (await observer.result<{ rows: { event: string; detail: { declined?: string } }[] }>("log")).rows.find(
                (row) => row.event === "machine_wake" && row.detail.declined === "paused",
              ),
            "recorded decline",
          );

          await forward(source, "sleeping/target", { body: "new message" });
          await quiet(http.calls);
        },
        {},
        { debounceS: 0 },
      );
    } finally {
      await http.stop();
    }
  });
  test("cross-account delivery leaves the machine asleep by default", async () => {
    const http = receiver();
    try {
      await scenario(name, async ({ target, bridge }) => {
        const a = await bridge("a", "alpha", [view("source")]);
        const b = await bridge("b", "sleeping");
        await b.result("machine_wake", { url: http.url, secret });
        await b.result("mirror", { endpoints: [hibernated()], full: true });
        await b.close();
        await target.contact("invite", "a", "b");
        await target.contact("accept", "b", "a");
        await forward(a, "b/sleeping/target");
        const deadline = Date.now() + 200;
        await waitFor(() => {
          expect(http.calls).toHaveLength(0);
          return Date.now() >= deadline;
        }, "no cross-account wake");
      });
    } finally {
      await http.stop();
    }
  });
  test("crossAccount=true enables one wake for a contact message", async () => {
    const http = receiver();
    try {
      await scenario(
        name,
        async ({ target, bridge, connect }) => {
          const a = await bridge("a", "alpha", [view("source")]);
          const b = await bridge("b", "sleeping");
          await b.result("machine_wake", { url: http.url, secret });
          await b.result("mirror", { endpoints: [hibernated()], full: true });
          await b.close();
          await target.contact("invite", "a", "b");
          await target.contact("accept", "b", "a");
          const sent = await forward(a, "b/sleeping/target");
          const call = await waitFor(() => http.calls[0], "contact wake", 2000);
          expect(JSON.parse(call.body)).toMatchObject({ account: "b", machine: "sleeping", from_account: "a", same_account: false, message: { id: sent.id } });
          const observer = await connect("b");
          await observer.hello({ observe: true });
          await waitFor(
            async () => (await observer.result<{ endpoints: { waking?: boolean }[] }>("list", { all: true })).endpoints.some((e) => e.waking),
            "contact waking row",
          );
          await forward(a, "b/sleeping/target", { body: "second" });
          await quiet(http.calls);
        },
        {},
        { crossAccount: true },
      );
    } finally {
      await http.stop();
    }
  });
});
