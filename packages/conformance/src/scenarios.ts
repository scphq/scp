import type { Envelope, SendResult } from "@scp-dev/core";
import type { HubWakeOptions } from "@scp-dev/hub";
import { ProcessTarget, waitFor } from "./targets";
import { Wire } from "./wire";

export const view = (handle: string, extra: object = {}) => ({
  address: `me/${handle}`,
  kind: "agent",
  harness: "cli",
  labels: {},
  presence: "online",
  tree: handle,
  parent_ep: null,
  parent_addr: null,
  depth: 0,
  ...extra,
});
export type Delivered = { seq: number; endpoint: string; message: Envelope };
export const delivered = (wire: Wire, id: string) =>
  waitFor(() => (wire.notifications("deliver") as Delivered[]).find((d) => d.message.id === id), "message delivery");
export const forward = (wire: Wire, to: string, extra: object = {}, from = "source") =>
  wire.result<SendResult>("forward", { from, params: { to, body: "hello", ...extra } });
export async function scenario(
  name: string,
  run: (f: {
    target: ProcessTarget;
    connect: (account?: string) => Promise<Wire>;
    bridge: (account: string, machine: string, endpoints?: object[]) => Promise<Wire>;
  }) => Promise<void>,
  limits: Record<string, number> = {},
  wake: Partial<HubWakeOptions> = {},
) {
  const target = new ProcessTarget(name);
  const sockets: Wire[] = [];
  const tokens = new Map<string, string>();
  const connect = async (account = "acme") => {
    let token = tokens.get(account);
    if (!token) {
      token = (await target.mint(account, "owner", { device: true })).token;
      tokens.set(account, token);
    }
    const wire = await Wire.connect(target.url, token);
    sockets.push(wire);
    return wire;
  };
  const errors: unknown[] = [];
  try {
    await target.start(limits, wake);
    await run({
      target,
      connect,
      bridge: async (account, machine, endpoints = []) => {
        const wire = await connect(account);
        await wire.hello({ machine, bridge: true });
        await wire.result("mirror", { endpoints, full: true });
        await wire.result("subscribe", { after: 0 });
        return wire;
      },
    });
  } catch (error) {
    errors.push(error);
  } finally {
    const results = await Promise.allSettled(sockets.map((wire) => wire.close()));
    await target.stop();
    errors.push(...results.filter((r) => r.status === "rejected").map((r) => r.reason));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "scenario failed");
}
