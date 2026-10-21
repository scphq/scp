import { expect, test } from "bun:test";
import { relayBinary } from "../../conformance/src/environment";
import { createDashboard } from "../src/server";

const targetPath = "../../conformance/src/targets";
test.skipIf(!relayBinary)("dashboard authenticates and reads the real Rust relay", async () => {
  const { ProcessTarget } = await import(targetPath);
  const relay = new ProcessTarget("rust-sqlite");
  let dashboard: ReturnType<typeof createDashboard> | undefined;
  try {
    await relay.start();
    const { token } = await relay.mint("demo", "owner");
    dashboard = createDashboard({ relay: relay.url });
    await new Promise<void>((resolve) => dashboard!.server.listen(0, "127.0.0.1", resolve));
    const address = dashboard.server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const base = `http://127.0.0.1:${address.port}`;
    const pre = await fetch(`${base}/v1/dashboard/session`);
    const { csrf } = (await pre.json()) as { csrf: string };
    const response = await fetch(`${base}/v1/dashboard/sign-in`, {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/json",
        cookie: pre.headers
          .getSetCookie()
          .map((s) => s.split(";")[0])
          .join("; "),
      },
      body: JSON.stringify({ csrf, token }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(token);
    const cookie = response.headers
      .getSetCookie()
      .map((s) => s.split(";")[0])
      .join("; ");
    const session = await fetch(`${base}/v1/dashboard/session`, { headers: { cookie } });
    expect(((await session.json()) as { org: { handle: string } }).org.handle).toBe("demo");
    const overview = await fetch(`${base}/v1/dashboard/overview`, { headers: { cookie } });
    expect(overview.status).toBe(200);
    expect(((await overview.json()) as { machines: unknown[] }).machines).toEqual([]);
  } finally {
    await dashboard?.close();
    await relay.stop();
  }
});
