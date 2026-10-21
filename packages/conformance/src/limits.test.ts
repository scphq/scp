import { describe, expect, test } from "bun:test";
import { scenario, view } from "./scenarios";
import { enabled, targetNames } from "./targets";

describe.each(targetNames)("%s hub limits conformance", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  test("socket capacity returns HTTP 429 too_many_sockets and frees after close", async () => {
    await scenario(
      name,
      async ({ target, connect }) => {
        const first = await connect();
        await first.hello({ observe: true });
        const token = (await target.mint("acme", "owner", { device: true })).token;
        const response = await fetch(`${target.url}/v1/relay/ws`, {
          headers: {
            authorization: `Bearer ${token}`,
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        });
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ error: "too_many_sockets" });
        await first.close();
        const next = await connect();
        expect(await next.hello({ observe: true })).toMatchObject({ limits: { sockets: 1 } });
      },
      { sockets: 1 },
    );
  });
  test("machine capacity refuses a new binding with too_large", async () => {
    await scenario(
      name,
      async ({ bridge, connect }) => {
        await bridge("acme", "alpha");
        const second = await connect();
        expect((await second.call("hello", { protocol: "scp/1", machine: "beta", bridge: true })).error?.data.code).toBe("too_large");
        const observer = await connect();
        await observer.hello({ observe: true });
        expect(await observer.result("machines")).toMatchObject({ machines: [expect.objectContaining({ name: "alpha" })] });
      },
      { machines: 1 },
    );
  });
  test("endpoint capacity refuses a mirror beyond the cap", async () => {
    await scenario(
      name,
      async ({ bridge }) => {
        const wire = await bridge("acme", "alpha", [view("first")]);
        expect((await wire.call("mirror", { endpoints: [view("second"), view("third")], full: false })).error?.data.code).toBe("too_large");
      },
      { endpoints: 2 },
    );
  });
  test("callsPerMinute refuses excess client calls with a positive retry_after", async () => {
    await scenario(
      name,
      async ({ connect }) => {
        const wire = await connect();
        await wire.hello({ observe: true });
        await wire.result("list");
        const excess = await wire.call("list");
        expect(excess.error?.data.code).toBe("rate_limited");
        expect(excess.error?.data.retry_after).toBeGreaterThan(0);
      },
      { callsPerMinute: 2 },
    );
  });
  test("Infinity disables machine and endpoint caps and is null in hello", async () => {
    await scenario(
      name,
      async ({ bridge, connect }) => {
        const wire = await connect();
        expect(await wire.hello({ observe: true })).toMatchObject({ limits: { machines: null, endpoints: null } });
        await bridge("acme", "alpha", [view("first"), view("second"), view("third")]);
        const second = await bridge("acme", "beta", [view("fourth")]);
        expect((await second.result<{ endpoints: object[] }>("list", { all: true })).endpoints.length).toBeGreaterThanOrEqual(4);
        const observer = await wire.result<{ machines: object[] }>("machines");
        expect(observer.machines).toHaveLength(2);
      },
      { machines: Infinity, endpoints: Infinity },
    );
  });
});
