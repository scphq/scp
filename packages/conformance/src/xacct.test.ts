import { describe, expect, test } from "bun:test";
import { delivered, forward, scenario, view } from "./scenarios";
import { enabled, targetNames } from "./targets";

describe.each(targetNames)("%s cross-account conformance", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  test("contacts exchange contact envelopes and scoped replies, and discover only allowlisted roots", async () => {
    await scenario(name, async ({ target, bridge }) => {
      const a = await bridge("a", "alpha", [view("source")]);
      const b = await bridge("b", "beta", [view("target"), view("child", { depth: 1, parent_ep: "target", tree: "target" })]);
      expect(await target.contact("invite", "a", "b")).toEqual({ account: "a", peer: "b", state: "pending_out" });
      expect(await target.contact("accept", "b", "a")).toEqual({ account: "b", peer: "a", state: "active" });
      const listed = await a.result<{ contacts: object[] }>("list", { contacts: true });
      expect(listed.contacts).toContainEqual({ address: "b/beta/target", harness: "cli", presence: "online" });
      const foreign = listed.contacts.filter((row) => (row as { address: string }).address.startsWith("b/"));
      expect(foreign).toEqual([{ address: "b/beta/target", harness: "cli", presence: "online" }]);
      const sent = await forward(a, "b/beta/target", { kind: "request" });
      const incoming = (await delivered(b, sent.id)).message;
      expect(incoming).toMatchObject({
        id: sent.id,
        thread: sent.thread,
        hop: sent.hop,
        data_class: "public",
        attachments: [],
        from: { address: "a/alpha/source", auth: "contact", rel: "contact:a", account: "a", user: "a", claims: { harness: "cli", model: null } },
      });
      await a.result("mirror", { endpoints: [view("source", { rules: { in: ["acct:other"] } })], full: false });
      await b.result("mirror", { endpoints: [view("target", { rules: { out: ["acct:other"] } })], full: false });
      const reply = await forward(b, "a/alpha/source", { reply_to: sent.id, kind: "reply", body: "reply" }, "target");
      expect(reply.thread).toBe(sent.thread);
      expect(reply.hop).toBe(sent.hop + 1);
      expect((await delivered(a, reply.id)).message).toMatchObject({
        thread: sent.thread,
        hop: sent.hop + 1,
        reply_to: sent.id,
        from: { auth: "contact", rel: "contact:b", account: "b" },
        body: { text: "reply" },
      });
    });
  });
  test("ingress refuses strangers, pending invites, direction, allowlist, scopes and revoked contacts", async () => {
    await scenario(name, async ({ target, bridge }) => {
      const a = await bridge("a", "alpha", [view("source")]);
      const b = await bridge("b", "beta", [view("target")]);
      const refused = async () => {
        expect((await a.call("forward", { from: "source", params: { to: "b/beta/target", body: "refused" } })).error?.data.code).toBe("not_found");
        expect(b.notifications("deliver")).toHaveLength(0);
      };
      await refused();
      await target.contact("invite", "a", "b");
      await refused();
      await target.contact("accept", "b", "a");
      await target.contact("update", "b", "a", { dir: "out" });
      await refused();
      expect(await a.result("list", { contacts: true })).toEqual({ contacts: [] });
      await target.contact("update", "b", "a", { dir: "both", allow: [{ machine: "beta", sel: "ep:beta/other" }] });
      await refused();
      await target.contact("update", "b", "a", { allow: [{ machine: "*", sel: "tree:root" }] });
      await b.result("mirror", { endpoints: [view("target", { rules: { in: ["acct:other"] } })], full: false });
      await refused();
      await b.result("mirror", { endpoints: [view("target", { rules: { in: ["acct:a"] } })], full: false });
      const sent = await forward(a, "b/beta/target");
      await delivered(b, sent.id);
      await target.contact("revoke", "a", "b");
      expect((await a.call("forward", { from: "source", params: { to: "b/beta/target", body: "revoked" } })).error?.data.code).toBe("not_found");
      expect(b.notifications("deliver")).toHaveLength(1);
    });
  });
  test("crossed invites, decline, block and revoke follow the contact state machine", async () => {
    await scenario(name, async ({ target, bridge }) => {
      const a = await bridge("a", "alpha", [view("source")]);
      const b = await bridge("b", "beta", [view("target")]);
      expect((await target.contact("invite", "a", "b")).state).toBe("pending_out");
      expect((await target.contact("decline", "b", "a")).state).toBeNull();
      expect((await target.contact("revoke", "a", "b")).state).toBeNull();
      await target.contact("invite", "a", "b");
      expect((await target.contact("invite", "b", "a")).state).toBe("active");
      const sent = await forward(a, "b/beta/target");
      await delivered(b, sent.id);
      expect((await target.contact("block", "b", "a")).state).toBe("blocked");
      expect((await target.contact("invite", "a", "b")).state).toBeNull();
      expect((await target.contact("revoke", "b", "a")).state).toBe("blocked");
      expect((await a.call("forward", { from: "source", params: { to: "b/beta/target", body: "blocked" } })).error?.data.code).toBe("not_found");
    });
  });
  test("cross-account size, data class, attachment and pair quotas have wire errors", async () => {
    await scenario(name, async ({ target, bridge }) => {
      const a = await bridge("a", "alpha", [view("source")]);
      const b = await bridge("b", "beta", [view("target")]);
      await target.contact("invite", "a", "b");
      await target.contact("accept", "b", "a");
      for (const [extra, code] of [
        [{ body: "é".repeat(8193) }, "too_large"],
        [{ attachments: [{ name: "file" }] }, "data_class_refused"],
        [{ data_class: "private" }, "data_class_refused"],
      ] as const) {
        expect(
          (await a.call("forward", { from: "source", params: { to: "b/beta/target", ...Object.assign({ body: "refuse" }, extra) } })).error?.data.code,
        ).toBe(code);
      }
      expect(b.notifications("deliver")).toHaveLength(0);
      for (let i = 0; i < 10; i++) {
        const sent = await forward(a, "b/beta/target", { body: i === 0 ? "é".repeat(8192) : `message ${i}` });
        await delivered(b, sent.id);
      }
      const eleventh = await a.call("forward", { from: "source", params: { to: "b/beta/target", body: "quota" } });
      expect(eleventh.error?.data.code).toBe("rate_limited");
      expect(eleventh.error?.data.retry_after).toBeGreaterThan(0);
      expect(b.notifications("deliver")).toHaveLength(10);
    });
  });
});
