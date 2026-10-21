import { describe, expect, test } from "bun:test";
import { enabled, ProcessTarget, targetNames, waitFor } from "./targets";
import { Wire } from "./wire";

const origin = "https://console.example.test";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
async function dashboard(name: string, run: (target: ProcessTarget) => Promise<void>) {
  const target = new ProcessTarget(name);
  try {
    await target.start({ revalidateMs: 100 }, {}, ["--cors-origin", origin]);
    await run(target);
  } finally {
    await target.stop();
  }
}
describe.each(targetNames)("%s dashboard conformance", (name) => {
  if (!enabled(name)) {
    test.skip("requires a configured relay target");
    return;
  }
  test("dashboard API requires a bearer identity on every route", () =>
    dashboard(name, async (target) => {
      for (const route of ["session", "overview", "graph", "events"]) {
        const response = await fetch(`${target.url}/v1/dashboard/${route}`);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ error: "unauthorized" });
      }
      const { token } = await target.mint("team", "owner");
      const response = await fetch(`${target.url}/v1/dashboard/session`, { headers: bearer(token) });
      expect(await response.json()).toMatchObject({ org: { handle: "team" }, member: { name: "owner", role: "owner" }, tokens: 1, scoped: true });
    }));
  test("dashboard overview and graph list an agent and isolate accounts", () =>
    dashboard(name, async (target) => {
      const a = await target.mint("team", "owner");
      const b = await target.mint("other", "owner");
      const wire = await Wire.connect(target.url, a.token);
      try {
        await wire.hello({ machine: "desk", claim: { handle: "agent" } });
        const overview = await fetch(`${target.url}/v1/dashboard/overview`, { headers: bearer(a.token) });
        expect(await overview.json()).toMatchObject({
          endpoints: expect.arrayContaining([expect.objectContaining({ address: "team/desk/agent", presence: "online" })]),
          machines: [expect.objectContaining({ name: "desk", online: true })],
        });
        const graph = await fetch(`${target.url}/v1/dashboard/graph?minutes=90`, { headers: bearer(a.token) });
        expect(await graph.json()).toMatchObject({ minutes: 60, nodes: expect.arrayContaining([expect.objectContaining({ address: "team/desk/agent" })]) });
        for (const route of ["overview?account=team", "graph?account=team"]) {
          const response = await fetch(`${target.url}/v1/dashboard/${route}`, { headers: bearer(b.token) });
          expect(JSON.stringify(await response.json())).not.toContain("team/desk/agent");
        }
        const session = await fetch(`${target.url}/v1/dashboard/session?account=team`, { headers: bearer(b.token) });
        expect(await session.json()).toMatchObject({ org: { handle: "other" } });
      } finally {
        await wire.close();
      }
    }));
  test("dashboard WebSocket sends hello then presence and pong, revocation closes 4003", () =>
    dashboard(name, async (target) => {
      const { token, credentialId } = await target.mint("team", "owner");
      const other = await target.mint("other", "owner");
      const otherEvents: Record<string, unknown>[] = [];
      const otherSocket = new WebSocket(`${target.url.replace(/^http/, "ws")}/v1/dashboard/events?account=team`, { headers: bearer(other.token) });
      otherSocket.addEventListener("message", (event) => otherEvents.push(JSON.parse(String(event.data))));
      const events: Record<string, unknown>[] = [];
      const texts: string[] = [];
      let closeCode: number | undefined;
      const ws = new WebSocket(`${target.url.replace(/^http/, "ws")}/v1/dashboard/events`, { headers: bearer(token) });
      ws.addEventListener("message", (event) => {
        if (event.data === "pong") texts.push("pong");
        else events.push(JSON.parse(String(event.data)));
      });
      ws.addEventListener("close", (event) => {
        closeCode = event.code;
      });
      let wire: Wire | undefined;
      try {
        await waitFor(() => events.length > 0, "dashboard hello");
        expect(events[0]?.type).toBe("hello");
        await waitFor(() => otherEvents.length > 0, "other account hello");
        wire = await Wire.connect(target.url, token);
        await wire.hello({ machine: "desk", claim: { handle: "agent" } });
        const presence = await waitFor(() => events.find((event) => event.type === "presence"), "dashboard presence");
        expect(presence).toMatchObject({ endpoint: "team/desk/agent", presence: "online" });
        expect(Object.keys(presence).sort()).toEqual(["at", "endpoint", "machine", "presence", "type"]);
        ws.send("ping");
        await waitFor(() => texts.includes("pong"), "dashboard pong");
        await Bun.sleep(50);
        expect(otherEvents.map((event) => event.type)).toEqual(["hello"]);
        await target.revoke(credentialId);
        await waitFor(() => closeCode, "dashboard revoked");
        expect(closeCode).toBe(4003);
      } finally {
        await wire?.close();
        ws.close();
        otherSocket.close();
      }
    }));
  test("dashboard SSE sends hello then presence and ends after revocation", () =>
    dashboard(name, async (target) => {
      const { token, credentialId } = await target.mint("team", "owner");
      const abort = new AbortController();
      let wire: Wire | undefined;
      try {
        const response = await fetch(`${target.url}/v1/dashboard/events`, { headers: bearer(token), signal: abort.signal });
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const events: Record<string, unknown>[] = [];
        let ended = false;
        const reading = (async () => {
          let pending = "";
          for await (const chunk of response.body!) {
            pending += new TextDecoder().decode(chunk);
            for (;;) {
              const end = pending.indexOf("\n\n");
              if (end < 0) break;
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = frame
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n");
              if (data) events.push(JSON.parse(data));
            }
          }
          ended = true;
        })();
        await waitFor(() => events.length > 0, "SSE hello");
        expect(events[0]?.type).toBe("hello");
        wire = await Wire.connect(target.url, token);
        await wire.hello({ machine: "desk", claim: { handle: "agent" } });
        expect(await waitFor(() => events.find((event) => event.type === "presence"), "SSE presence")).toMatchObject({
          endpoint: "team/desk/agent",
          presence: "online",
        });
        await target.revoke(credentialId);
        await waitFor(() => ended, "SSE end");
        await reading;
      } finally {
        abort.abort();
        await wire?.close();
      }
    }));
  test("dashboard CORS allows only exact configured origins", () =>
    dashboard(name, async (target) => {
      for (const allowed of [true, false]) {
        const response = await fetch(`${target.url}/v1/dashboard/overview`, {
          method: "OPTIONS",
          headers: {
            origin: allowed ? origin : "https://other.example.test",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        });
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(allowed ? origin : null);
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        if (allowed) {
          expect(response.headers.get("vary")).toBe("origin");
          expect(response.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
          expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
          expect(response.headers.get("access-control-max-age")).toBe("600");
        }
      }
    }));
});
