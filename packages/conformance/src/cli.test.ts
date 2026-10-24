import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EndpointView, Envelope, SendResult } from "@scp-dev/core";
import { enabled, ProcessTarget, targetNames, waitFor } from "./targets";
import { ensureBuilt, Machine } from "./machines";
import { Wire } from "./wire";

describe.each(targetNames)("%s CLI conformance", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  const target = new ProcessTarget(name);
  const machines: Machine[] = [];
  const sockets: Wire[] = [];
  let laptop: Machine;
  let desk: Machine;
  let direct: Machine;
  beforeAll(async () => {
    ensureBuilt();
    await target.start();
    const credential = await target.mint("acme", "ada", { device: true });
    for (const machine of ["laptop", "desk", "ci"]) machines.push(new Machine(machine, target, credential.token));
    [laptop, desk, direct] = machines as [Machine, Machine, Machine];
    for (const machine of machines) machine.assertIsolated();
    await Promise.all([laptop.start(), desk.start()]);
    await Promise.all([laptop.claim("ada"), desk.claim("bob")]);
    await waitFor(async () => (await laptop.list()).some((e) => e.address === "me/desk/bob"), "desk/bob discovery");
    await waitFor(async () => (await desk.list()).some((e) => e.address === "me/laptop/ada"), "laptop/ada discovery");
  }, 60000);
  afterAll(async () => {
    const results = await Promise.allSettled([...sockets.map((socket) => socket.close()), ...machines.map((machine) => machine.stop())]);
    await target.stop();
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "fixture cleanup failed");
  });
  test("two bridged machines exchange a message and reply on the same thread", async () => {
    const sent = await laptop.send("ada", "desk/bob", "hello desk");
    expect(sent.deliveries).toHaveLength(1);
    const incoming = await waitFor(async () => (await desk.inbox("bob", true)).find((m) => m.id === sent.id), "desk inbox");
    expect(incoming.from.address).toBe("me/laptop/ada");
    expect(incoming.body.text).toBe("hello desk");
    const reply = await desk.json<SendResult>(["reply", sent.id, "hello laptop", "--as", "bob"]);
    expect(reply.thread).toBe(sent.thread);
    const received = await waitFor(async () => (await laptop.inbox("ada", true)).find((m) => m.id === reply.id), "laptop reply");
    expect(received.thread).toBe(sent.thread);
    expect(received.from.address).toBe("me/desk/bob");
    expect(received.body.text).toBe("hello laptop");
    expect(received.reply_to).toBe(sent.id);
    await Promise.all([laptop.inbox("ada"), desk.inbox("bob")]);
  }, 60000);
  test("presence converges online, offline and online across a broker restart", async () => {
    await waitFor(async () => (await laptop.list()).find((e) => e.address === "me/desk/bob" && e.presence === "online"), "desk online");
    await desk.stopBroker();
    await waitFor(async () => (await laptop.list()).find((e) => e.address === "me/desk/bob" && e.presence === "offline"), "desk offline");
    await desk.start();
    await desk.claim("bob");
    await waitFor(async () => (await laptop.list()).find((e) => e.address === "me/desk/bob" && e.presence === "online"), "desk online again");
  }, 60000);
  test("queues once during broker outage and persists a queued delivery across relay restart", async () => {
    await desk.stopBroker();
    await waitFor(async () => (await laptop.list()).some((e) => e.address === "me/desk/bob" && e.presence === "offline"), "desk disconnected");
    const queued = await laptop.send("ada", "desk/bob", "queued once");
    await desk.start();
    await desk.claim("bob");
    const inbox = await waitFor(async () => {
      const rows = await desk.inbox("bob", true);
      return rows.some((m) => m.id === queued.id) && rows;
    }, "queued delivery");
    expect(inbox.filter((m) => m.id === queued.id)).toHaveLength(1);
    await desk.inbox("bob");
    await target.restart();
    await Promise.all([laptop.linked(), desk.linked()]);
    const relinked = await desk.send("bob", "laptop/ada", "both bridges relinked");
    await waitFor(async () => (await laptop.inbox("ada", true)).some((m) => m.id === relinked.id), "both bridges after restart");
    await laptop.inbox("ada");
    await desk.stopBroker();
    await waitFor(async () => (await laptop.list()).some((e) => e.address === "me/desk/bob" && e.presence === "offline"), "desk disconnected again");
    const persisted = await laptop.send("ada", "desk/bob", "survives relay restart");
    await target.restart();
    await laptop.linked();
    await desk.start();
    await desk.claim("bob");
    const restored = await waitFor(async () => {
      const rows = await desk.inbox("bob", true);
      return rows.some((m) => m.id === persisted.id) && rows;
    }, "persisted delivery");
    expect(restored.filter((m) => m.id === persisted.id)).toHaveLength(1);
    expect(restored.some((m) => m.id === queued.id)).toBe(false);
    await desk.inbox("bob");
    expect(await desk.inbox("bob")).toEqual([]);
    const sent = await desk.send("bob", "laptop/ada", "after restart");
    expect((await waitFor(async () => (await laptop.inbox("ada", true)).find((m) => m.id === sent.id), "post-restart message")).body.text).toBe(
      "after restart",
    );
    await laptop.inbox("ada");
  }, 60000);
  test("spawn via a runner exposes the cross-machine parent on both sides and hands back", async () => {
    const runnerEnv = join(laptop.root, "desk-env.json");
    const runners = join(laptop.root, "runners.json");
    const harness = join(laptop.root, "worker.ts");
    const release = join(laptop.root, "release");
    const ready = join(laptop.root, "ready");
    writeFileSync(runnerEnv, JSON.stringify(desk.env));
    writeFileSync(
      runners,
      JSON.stringify({
        desk: {
          command: [process.execPath, "--no-env-file", join(import.meta.dir, "runner.ts"), runnerEnv],
          stop: [process.execPath, "--no-env-file", join(import.meta.dir, "runner.ts"), runnerEnv],
          status: [process.execPath, "--no-env-file", join(import.meta.dir, "runner.ts"), runnerEnv],
          timeout_s: 10,
        },
      }),
    );
    writeFileSync(
      harness,
      `await Bun.write(${JSON.stringify(ready)}, "ready");\nconst until = Date.now() + 5000;\nwhile (!(await Bun.file(${JSON.stringify(release)}).exists()) && Date.now() < until) await Bun.sleep(20);\nconsole.log("worker done");\n`,
    );
    const spawned = laptop.json<{ machine: string; address: string; parent: string }>(
      ["spawn", "--via", "desk", "--name", "worker", "--as", "ada", "--", process.execPath, "--no-env-file", harness],
      { SCP_RUNNERS_FILE: runners },
    );
    // Attach the handler while observing the live worker.
    const outcome = spawned.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await waitFor(() => existsSync(ready), "worker start");
      const remote = await waitFor(async () => (await laptop.list()).find((e) => e.address === "me/desk/worker" && e.parent === "me/ada"), "parent on laptop");
      expect(remote.parent).toBe("me/ada");
      const local = (await desk.list()).find((e) => e.address === "me/worker");
      expect(local?.parent).toBe("me/laptop/ada");
      const observer = await Wire.connect(target.url, (await target.mint("acme", "ada")).token);
      sockets.push(observer);
      const hello = await observer.hello({ bridge: true, machine: "parent-view" });
      const view = (hello.endpoints as { address: string; parent_addr?: string }[]).find((e) => e.address === "acme/desk/worker");
      expect(view?.parent_addr).toBe("laptop/ada");
    } finally {
      writeFileSync(release, "done");
      await outcome;
    }
    const result = await outcome;
    if ("error" in result) throw result.error;
    expect(result.value).toMatchObject({ machine: "desk", address: "me/desk/worker", parent: "me/laptop/ada" });
    const handback = await waitFor(async () => (await laptop.inbox("ada", true)).find((m) => m.from.address === "me/desk/worker"), "handback");
    expect(handback.kind).toBe("message");
    expect(handback.body.text).toContain("worker done");
    const listed = await laptop.json<{ endpoints: EndpointView[] }>(["list", "--all", "--as", "ada"]);
    expect(listed.endpoints.find((e) => e.address === "me/desk/worker")?.runner).toMatchObject({
      name: "desk",
      attach: "ssh desk -t tmux attach -t worker",
      status: { state: "stopped" },
    });
    expect(await laptop.json(["end", "me/desk/worker", "--as", "ada"])).toMatchObject({ held: false, runner: { name: "desk", stop: "stopped" } });
    expect(await Bun.file(join(laptop.root, "runner-stop.json")).json()).toMatchObject({
      scp: 1,
      event: "stop",
      name: "worker",
      runner: "desk",
      parent: "me/laptop/ada",
      address: "me/desk/worker",
    });
    await laptop.inbox("ada");
  }, 60000);
  test("direct cloud clients send, receive and list both bridged machines without a broker", async () => {
    const cloud = { SCP_TRANSPORT: "cloud" };
    await direct.json(["whoami", "--as", "tester"], cloud);
    const sent = await direct.json<SendResult>(["send", "laptop/ada", "from cloud", "--as", "tester"], cloud);
    const incoming = await waitFor(async () => (await laptop.inbox("ada", true)).find((m) => m.id === sent.id), "cloud message");
    expect(incoming.from.address).toBe("me/ci/tester");
    await waitFor(async () => (await laptop.list()).some((e) => e.address === "me/ci/tester"), "cloud endpoint");
    const reply = await laptop.send("ada", "ci/tester", "back to cloud");
    const inbox = await direct.json<{ messages: Envelope[] }>(["inbox", "--as", "tester"], cloud);
    expect(inbox.messages.find((m) => m.id === reply.id)?.from.address).toBe("acme/laptop/ada");
    const listed = await direct.json<{ machines: { name: string; bridge: boolean; online: boolean }[] }>(["machines"], cloud);
    for (const machine of ["laptop", "desk"]) expect(listed.machines.find((m) => m.name === machine)).toMatchObject({ bridge: true, online: true });
    expect(existsSync(join(direct.env.SCP_DIR!, "broker.lock"))).toBe(false);
  }, 60000);
});
