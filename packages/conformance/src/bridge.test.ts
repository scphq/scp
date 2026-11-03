import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { swarmBinary } from "./environment";
import { ensureBuilt, Machine } from "./machines";
import { enabled, ProcessTarget, targetNames, waitFor } from "./targets";
import { Wire } from "./wire";

type BrokerStatus = { enabled: boolean; machine?: string; url?: string; connected?: boolean; last_error?: string | null; since?: string };
type CloudStatus = { file: string; config: { bridge: true; machine: string; url: string } | null; config_error?: string; broker: BrokerStatus };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe.each(targetNames)("%s hub bridge lifecycle", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  const target = new ProcessTarget(name);
  const machines: Machine[] = [];
  const sockets: Wire[] = [];
  let token: string;
  let origin: string;
  let desk: Machine;
  const machine = (machineName: string) => {
    const made = new Machine(machineName, target, token);
    machines.push(made);
    return made;
  };
  const status = (m: Machine) => m.json<CloudStatus>(["cloud", "status"]);
  const restarted = async (m: Machine, pid: number) => {
    await waitFor(() => m.exited, `${m.name} broker exit`);
    const view = await waitFor(async () => {
      const shown = await status(m);
      return shown.broker.connected && shown;
    }, `${m.name} fresh link`);
    const fresh = await m.brokerPid();
    expect(fresh).not.toBe(pid);
    if (m.native && swarmBinary)
      expect(
        Bun.spawnSync(["ps", "-o", "comm=", "-p", String(fresh)])
          .stdout.toString()
          .trim(),
      ).toEndWith("swarm");
    return view;
  };
  beforeAll(async () => {
    ensureBuilt();
    await target.start();
    token = (await target.mint("acme", "ada", { device: true })).token;
    origin = new URL(target.url).origin;
    desk = machine("desk");
    await desk.start();
    await desk.claim("bob");
  }, 60000);
  afterAll(async () => {
    const results = await Promise.allSettled([...sockets.map((socket) => socket.close()), ...machines.map((m) => m.stop())]);
    await target.stop();
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "fixture cleanup failed");
  });

  test("cloud status shows a linked broker's link in one shape", async () => {
    const m = machine("laptop");
    await m.start();
    const view = await status(m);
    expect(view.file).toBe(join(m.env.XDG_CONFIG_HOME!, "scp", "cloud.json"));
    expect(view.config).toEqual({ bridge: true, machine: "laptop", url: origin });
    expect(Object.keys(view.broker).sort()).toEqual(["connected", "enabled", "last_error", "machine", "since", "url"]);
    expect(view.broker).toMatchObject({ enabled: true, machine: "laptop", url: origin, connected: true, last_error: null });
    expect(view.broker.since).toMatch(ISO);
    expect(Date.parse(view.broker.since!)).toBeLessThanOrEqual(Date.now());
  }, 60000);

  test("swarm login relinks a broker that had no credential in place", async () => {
    const m = machine("pad");
    delete m.env.SCP_TOKEN;
    await m.start({ linked: false });
    const down = await status(m);
    expect(down.broker).toMatchObject({
      enabled: true,
      machine: "pad",
      url: origin,
      connected: false,
      last_error: `no login for ${origin}: run swarm login, or set SCP_TOKEN; running local-only`,
    });
    expect(down.broker.since).toMatch(ISO);
    const pid = await m.brokerPid();
    await m.run(["login", "--token", token]);
    await m.linked();
    expect(await m.brokerPid()).toBe(pid);
    expect(m.exited).toBe(false);
    expect((await status(m)).broker.last_error).toBeNull();
  }, 60000);

  test("a replaced bridge stays down until cloud enable relinks it in place", async () => {
    const m = machine("tab");
    await m.start();
    const pid = await m.brokerPid();
    const rival = await Wire.connect(target.url, token);
    sockets.push(rival);
    await rival.hello({ machine: "tab", bridge: true });
    const replaced = await waitFor(async () => {
      const broker = (await status(m)).broker;
      return !broker.connected && broker;
    }, "replaced bridge");
    expect(replaced.last_error).toStartWith("replaced: ");
    await rival.close();
    await Bun.sleep(1500);
    expect((await status(m)).broker).toMatchObject({ connected: false, last_error: replaced.last_error });
    await m.run(["cloud", "enable", "--machine", "tab"]);
    await m.linked();
    expect(await m.brokerPid()).toBe(pid);
    expect(m.exited).toBe(false);
  }, 60000);

  test("cloud enable under another machine name restarts the broker and the fresh one links under it", async () => {
    const m = machine("old");
    await m.start();
    const pid = await m.brokerPid();
    await m.run(["cloud", "enable", "--machine", "renamed"], {}, 30000);
    const view = await restarted(m, pid);
    expect(view.config?.machine).toBe("renamed");
    expect(view.broker).toMatchObject({ enabled: true, machine: "renamed", url: origin, last_error: null });
  }, 60000);

  test("cloud.json that appears under a local-only broker restarts it on cloud enable", async () => {
    const m = machine("fresh");
    await m.start({ cloud: false });
    const local = await status(m);
    expect(local.config).toBeNull();
    expect(local.broker).toEqual({ enabled: false });
    const pid = await m.brokerPid();
    await m.run(["cloud", "enable", "--machine", "fresh"], {}, 30000);
    const view = await restarted(m, pid);
    expect(view.broker).toMatchObject({ enabled: true, machine: "fresh", url: origin });
  }, 60000);

  test("cloud disable keeps the running link, also across a relink, until the broker exits", async () => {
    const m = machine("kept");
    await m.start();
    const pid = await m.brokerPid();
    expect(await m.json<{ removed: boolean }>(["cloud", "disable"])).toMatchObject({ removed: true });
    const kept = await status(m);
    expect(kept.config).toBeNull();
    expect(kept.broker).toMatchObject({ enabled: true, machine: "kept", connected: true });
    await m.run(["login", "--token", token]);
    expect(await m.brokerPid()).toBe(pid);
    await m.linked();
    await m.claim("kim");
    await waitFor(async () => (await m.list()).some((e) => e.address === "me/desk/bob"), "desk/bob on kept");
    const sent = await m.send("kim", "desk/bob", "still linked");
    await waitFor(async () => (await desk.inbox("bob", true)).some((e) => e.id === sent.id), "desk inbox");
    await desk.inbox("bob");
    await m.stopBroker();
    await m.start({ cloud: false });
    expect((await status(m)).broker).toEqual({ enabled: false });
  }, 60000);

  test("a message from another machine runs a hibernated agent's waker and lands once it is claimed", async () => {
    const m = machine("sleeper");
    const record = join(m.root, "wake.json");
    const script = join(m.root, "wake.ts");
    writeFileSync(
      join(m.env.XDG_CONFIG_HOME!, "scp", "wakers.json"),
      JSON.stringify({ vm: { command: [process.execPath, "--no-env-file", script], timeout_s: 5 } }),
    );
    writeFileSync(
      script,
      `const input = await new Response(Bun.stdin.stream()).text();\nconst env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("SCP_WAKE_")));\nawait Bun.write(${JSON.stringify(record)}, JSON.stringify({ input: JSON.parse(input), env }));\n`,
    );
    await m.start();
    await m.claim("ada");
    await m.json(["hibernate", "--wake", "vm", "--ref", "box-42", "--as", "ada"]);
    await waitFor(async () => (await desk.list()).some((e) => e.address === "me/sleeper/ada" && e.presence === "hibernated"), "hibernated mirror");
    const sent = await desk.send("bob", "sleeper/ada", "PRIVATE-QUEUED-BODY");
    expect(sent.deliveries[0]).toMatchObject({ queued: true, hibernated: true });
    const woken = await waitFor(() => {
      if (!existsSync(record)) return false;
      try {
        return JSON.parse(readFileSync(record, "utf8"));
      } catch {
        return false;
      }
    }, "waker run");
    expect(woken.input).toMatchObject({ provider: "vm", ref: "box-42", endpoint: "me/ada", message: { id: sent.id } });
    expect(woken.env).toMatchObject({ SCP_WAKE_PROVIDER: "vm", SCP_WAKE_REF: "box-42", SCP_WAKE_HANDLE: "ada", SCP_WAKE_MESSAGE_ID: sent.id });
    expect(JSON.stringify(woken)).not.toContain("PRIVATE-QUEUED-BODY");
    await m.claim("ada");
    await waitFor(async () => (await desk.list()).some((e) => e.address === "me/sleeper/ada" && e.presence === "online"), "resumed mirror");
    expect((await m.inbox("ada")).filter((e) => e.id === sent.id)).toHaveLength(1);
  }, 60000);
});
