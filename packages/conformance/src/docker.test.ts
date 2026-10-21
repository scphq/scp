import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { enabled, ProcessTarget, targetNames } from "./targets";

for (const name of targetNames.filter((name) => name === "docker")) {
  describe(`${name} container`, () => {
    if (!enabled(name)) return;
    const target = new ProcessTarget(name);
    beforeAll(() => target.start(), 60000);
    afterAll(() => target.stop(), 20000);
    test("container preserves its address and credentials across restart", async () => {
      const url = target.url;
      const { token } = await target.mint("restart-demo", "owner");
      await target.restart();
      expect(target.url).toBe(url);
      const response = await fetch(`${target.url}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ org: "restart-demo" });
    }, 20000);
    test("dashboard public API serves bearer session and overview", async () => {
      const { token } = await target.mint("dashboard-demo", "owner");
      const headers = { authorization: `Bearer ${token}` };
      const session = await fetch(`${target.url}/v1/dashboard/session`, { headers });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ org: { handle: "dashboard-demo" }, scoped: true });
      const overview = await fetch(`${target.url}/v1/dashboard/overview`, { headers });
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({ machines: [], endpoints: expect.any(Array), activity: [] });
    });
  });
}
