import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SendResult } from "@scp-dev/core";
import { COMPAT_FIXTURE, compatProgram, COMPAT_VERSION } from "./compat";
import { compatConformance } from "./environment";
import { ensureBuilt, Machine } from "./machines";
import { enabled, ProcessTarget, targetNames, waitFor } from "./targets";
import { Wire } from "./wire";

for (const name of targetNames) {
  for (const variant of ["old pair", "old laptop", "old desk"] as const) {
    describe(`${name} CLI ${COMPAT_VERSION} ${variant} compatibility`, () => {
      if (name === "docker") {
        test.skip("pinned broker compatibility does not support docker");
        return;
      }
      if (!compatConformance || !enabled(name)) {
        test.skip(!compatConformance ? "requires SCP_CONFORMANCE_COMPAT=1" : "requires SCP_RELAY_BIN");
        return;
      }
      const target = new ProcessTarget(name);
      const machines: Machine[] = [];
      const sockets: Wire[] = [];
      let laptop: Machine;
      let desk: Machine;
      let observer: Wire;
      let hello: Record<string, unknown>;
      let cleanupInstall: (() => void) | undefined;
      beforeAll(async () => {
        const install = await compatProgram();
        cleanupInstall = install.cleanup;
        const program = install.program;
        ensureBuilt();
        await target.start();
        const { token } = await target.mint("acme", "ada", { device: true });
        laptop = new Machine("laptop", target, token, variant === "old desk" ? undefined : program);
        desk = new Machine("desk", target, token, variant === "old laptop" ? undefined : program);
        machines.push(laptop, desk);
        const config = join(laptop.env.XDG_CONFIG_HOME!, "scp");
        mkdirSync(config, { recursive: true });
        writeFileSync(join(config, "wakers.json"), JSON.stringify({ vm: { command: ["node", join(laptop.root, "wake.cjs")], timeout_s: 2 } }));
        writeFileSync(
          join(laptop.root, "wake.cjs"),
          `let input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => require("node:fs").writeFileSync(process.env.HOME + "/wake.json", JSON.stringify({input: JSON.parse(input), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("SCP_WAKE_")))})));`,
        );
        await Promise.all(machines.map((m) => m.start()));
        await Promise.all([laptop.claim("ada"), desk.claim("bob")]);
        observer = await Wire.connect(target.url, token);
        sockets.push(observer);
        hello = await observer.hello({ machine: "observer", bridge: true });
      }, 180000);
      afterAll(async () => {
        const results = await Promise.allSettled([...sockets.map((s) => s.close()), ...machines.map((m) => m.stop())]);
        try {
          await target.stop();
        } finally {
          cleanupInstall?.();
        }
        const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason);
        if (errors.length) throw new AggregateError(errors, "fixture cleanup failed");
      });
      const hubList = async () =>
        (await observer.result<{ endpoints: { address: string; presence: string; wake?: string | null }[] }>("list", { all: true })).endpoints;
      test("version pin matches the fixture manifest", () => {
        const manifest = JSON.parse(readFileSync(join(COMPAT_FIXTURE, "package.json"), "utf8"));
        expect(manifest.dependencies["@scp-dev/cli"]).toBe(COMPAT_VERSION);
      });
      test("hello metadata and bridge link", async () => {
        await Promise.all(machines.map((m) => m.linked()));
        for (const m of machines) m.assertIsolated();
        expect(hello.endpoints).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ address: "acme/laptop/ada", machine: "laptop", presence: "online" }),
            expect.objectContaining({ address: "acme/desk/bob", machine: "desk", presence: "online" }),
          ]),
        );
      });
      test("mirror reaches the peer and hub", async () => {
        await waitFor(async () => (await desk.list()).some((e) => e.address === "me/laptop/ada"), "old mirror on peer");
        await waitFor(async () => (await laptop.list()).some((e) => e.address === "me/desk/bob"), "peer mirror on old");
        expect(await hubList()).toContainEqual(expect.objectContaining({ address: "acme/laptop/ada", presence: "online" }));
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
      test("hibernate mirrors, queues, invokes the waker and clears on claim", async () => {
        await laptop.json(["hibernate", "--wake", "vm", "--ref", "box-42", "--as", "ada"]);
        await waitFor(async () => (await desk.list()).some((e) => e.address === "me/laptop/ada" && e.presence === "hibernated"), "hibernated peer mirror");
        await waitFor(async () => (await hubList()).some((e) => e.address === "acme/laptop/ada" && e.presence === "hibernated"), "hibernated hub mirror");
        const sent = await desk.send("bob", "laptop/ada", "PRIVATE-QUEUED-BODY");
        expect(sent.deliveries[0]).toMatchObject({ queued: true, hibernated: true });
        const path = join(laptop.root, "wake.json");
        const record = await waitFor(() => {
          if (!existsSync(path)) return false;
          try {
            return JSON.parse(readFileSync(path, "utf8"));
          } catch {
            return false;
          }
        }, "fake waker");
        expect(record.input).toMatchObject({ provider: "vm", ref: "box-42", endpoint: "me/ada", message: { id: sent.id } });
        expect(record.env).toMatchObject({ SCP_WAKE_PROVIDER: "vm", SCP_WAKE_REF: "box-42", SCP_WAKE_HANDLE: "ada", SCP_WAKE_MESSAGE_ID: sent.id });
        expect(JSON.stringify(record)).not.toContain("PRIVATE-QUEUED-BODY");
        await laptop.claim("ada");
        await waitFor(async () => (await desk.list()).some((e) => e.address === "me/laptop/ada" && e.presence === "online"), "resumed peer mirror");
        await waitFor(async () => (await hubList()).some((e) => e.address === "acme/laptop/ada" && e.presence === "online" && !e.wake), "resumed hub mirror");
        expect((await laptop.inbox("ada")).filter((m) => m.id === sent.id)).toHaveLength(1);
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
            desk: { command: [process.execPath, "--no-env-file", join(import.meta.dir, "runner.ts"), runnerEnv, JSON.stringify(desk.program)], timeout_s: 10 },
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
          const remote = await waitFor(
            async () => (await laptop.list()).find((e) => e.address === "me/desk/worker" && e.parent === "me/ada"),
            "parent on laptop",
          );
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
        await laptop.inbox("ada");
      }, 60000);
    });
  }
}
