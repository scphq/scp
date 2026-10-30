import { afterEach, beforeAll, test as bunTest, describe, expect, setDefaultTimeout } from "bun:test";
import { ensureBuilt } from "../../../cli/src/testing/fixtures";
import { brokerReferenceWakers } from "../environment";
import { type BrokerFiles, BrokerTarget, brokerTargetEnabled, brokerTargetNames } from "./target";
import { BrokerWire, type Hello, violations } from "./wire";

export type Claim = { handle: string; harness?: string; [key: string]: unknown };

/** one running broker for a test, with helpers that only speak the socket protocol */
export class BrokerFixture {
  private wires: BrokerWire[] = [];
  constructor(readonly target: BrokerTarget) {}
  async wire() {
    const wire = await BrokerWire.connect(this.target.socket);
    this.wires.push(wire);
    return wire;
  }
  /** a session connection claiming `handle` */
  async agent(handle: string, harness = "claude-code", extra: Record<string, unknown> = {}, claim: Record<string, unknown> = {}) {
    const wire = await this.wire();
    const hello = await wire.hello({ claim: { handle, harness, ...claim }, ...extra });
    return Object.assign(wire, { hello, id: hello.endpoint!.id, address: hello.endpoint!.address });
  }
  /** the human, at a terminal unless `tty` is false */
  async human(tty = true) {
    const wire = await this.wire();
    const hello = await wire.hello({ human: true, tty });
    return Object.assign(wire, { hello });
  }
  async observer(extra: Record<string, unknown> = {}) {
    const wire = await this.wire();
    const hello = await wire.hello({ observe: true, ...extra });
    return Object.assign(wire, { hello });
  }
  /** a transient hook connection; it closes after `hello` resolves unless kept */
  async hook(claim: Claim, extra: Record<string, unknown> = {}) {
    const wire = await this.wire();
    const hello = await wire.hello<Hello>({ transient: true, claim: { harness: "claude-code", ...claim }, ...extra });
    return Object.assign(wire, { hello });
  }
  async restart() {
    await this.closeWires();
    await this.target.restart();
  }
  async closeWires() {
    for (const wire of this.wires.splice(0)) await wire.close();
  }
}

export type Start = (files?: BrokerFiles) => Promise<BrokerFixture>;

/** suites the native engine does not implement yet; they are registered as pending on the `rust` target */
export const rustPending = new Set([
  "broker peek",
  "broker grant redemption and incarnation",
  "broker grant validation",
  "broker spawn",
  "broker durable spawn holds",
  "broker spawn supervision",
  "broker wake and hibernation",
  "broker reference waker binding",
]);

/** single tests the native engine does not implement yet, as `<suite title> > <test name>`; they are todo on the `rust` target */
export const rustPendingTests = new Set([
  "broker push > a waker interrupts a waiting stop and future stops return promptly",
  "broker push > gathering returns promptly when interrupted by wake",
]);

let registering: { title: string; name: string } | undefined;

/** bun's `test`, registered as todo on the `rust` target when {@link rustPendingTests} lists it */
export const test = Object.assign((name: string, fn: () => void | Promise<unknown>, timeout?: number) => {
  if (registering?.name === "rust" && rustPendingTests.has(`${registering.title} > ${name}`)) return bunTest.todo(name);
  return bunTest(name, fn, timeout);
}, bunTest) as typeof bunTest;

/**
 * registers `body` once per broker target; each test calls `start` for a fresh broker. A disabled target is skipped by name.
 * After every test the fixture fails it when any frame either way broke the wire schemas.
 */
export function brokerSuite(title: string, body: (start: Start) => void, options: { referenceWakers?: boolean } = {}) {
  setDefaultTimeout(30_000);
  for (const name of brokerTargetNames) {
    const skipped = !brokerTargetEnabled(name) || (options.referenceWakers === true && name === "rust" && !brokerReferenceWakers);
    if (name === "rust" && rustPending.has(title)) {
      describe.todo(`${title} [${name}]`, () => {});
      continue;
    }
    describe.skipIf(skipped)(`${title} [${name}]`, () => {
      const fixtures: BrokerFixture[] = [];
      beforeAll(() => ensureBuilt(), 180_000);
      afterEach(async () => {
        for (const fixture of fixtures.splice(0)) {
          await fixture.closeWires();
          await fixture.target.dispose();
        }
        expect(violations.splice(0)).toEqual([]);
      });
      registering = { title, name };
      body(async (files) => {
        const target = new BrokerTarget(name, files);
        const fixture = new BrokerFixture(target);
        fixtures.push(fixture);
        await target.start();
        return fixture;
      });
      registering = undefined;
    });
  }
}
