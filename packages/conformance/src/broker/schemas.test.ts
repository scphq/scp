import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { lint, methodNames, schemaDir, schemaFiles, validate, validateSchema } from "./schema";

const spec = readFileSync(join(import.meta.dir, "../../../spec/SPEC.md"), "utf8");
const protocol = join(import.meta.dir, "../../../core/src/protocol.ts");

/** the TS types the schemas mirror, by $def name in types.schema.json */
const MIRRORED = [
  "Envelope",
  "EndpointView",
  "ActivityRow",
  "ScopeView",
  "ScopeEntry",
  "ScopeCap",
  "ScopeChange",
  "PeerView",
  "WhyResult",
  "PeekResult",
  "PeekTurn",
  "StopWaitResult",
  "StopNudge",
  "SendParams",
  "SendResult",
  "AskResult",
  "AdoptResult",
  "MessageReceipts",
  "AuditRow",
  "JudgeHeld",
  "JudgeRedacted",
  "Attachment",
];

function tsShapes(names: string[]) {
  const program = ts.createProgram([protocol], { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, noEmit: true, types: [] });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(protocol)!;
  const shapes = new Map<string, { keys: string[]; required: string[] }>();
  ts.forEachChild(source, (node) => {
    if (!(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) || !names.includes(node.name.text)) return;
    const type = checker.getTypeAtLocation(node.name);
    if (type.isUnion()) return;
    const properties = checker.getPropertiesOfType(type);
    shapes.set(node.name.text, {
      keys: properties.map((symbol) => symbol.name).sort(),
      required: properties
        .filter((symbol) => !(symbol.flags & ts.SymbolFlags.Optional))
        .map((symbol) => symbol.name)
        .sort(),
    });
  });
  return shapes;
}

describe("broker wire schemas", () => {
  test("date-time validates calendar dates, times and offsets", () => {
    for (const value of ["2024-02-29T23:59:59Z", "2000-02-29T00:00:00.123+05:30", "2026-04-30T10:00:00-04:00"]) {
      expect(validateSchema({ type: "string", format: "date-time" }, value), value).toEqual([]);
    }
    for (const value of [
      "2026-13-45T99:99:99Z",
      "2026-02-30T10:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-00-01T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:60Z",
      "2026-01-01T00:00:00+24:00",
    ]) {
      expect(validateSchema({ type: "string", format: "date-time" }, value).length, value).toBeGreaterThan(0);
    }
  });

  test("oneOf requires exactly one matching branch", () => {
    const schema = { oneOf: [{ type: "number" }, { type: "integer" }] };
    expect(validateSchema(schema, 1.5)).toEqual([]);
    expect(validateSchema(schema, 1).length).toBeGreaterThan(0);
    expect(validateSchema(schema, "one").length).toBeGreaterThan(0);
  });

  test("additionalProperties false rejects unknown members", () => {
    const schema = { type: "object", properties: { known: { type: "string" } }, additionalProperties: false };
    expect(validateSchema(schema, { known: "yes" })).toEqual([]);
    expect(validateSchema(schema, { extra: true }).length).toBeGreaterThan(0);
  });

  test("references across files validate the referenced value", () => {
    const schema = { $ref: "../types.schema.json#/$defs/Timestamp" };
    expect(validateSchema(schema, "2024-02-29T00:00:00Z", "methods/hello.schema.json")).toEqual([]);
    expect(validateSchema(schema, "2026-02-30T00:00:00Z", "methods/hello.schema.json").length).toBeGreaterThan(0);
  });

  test("optional grant conveyance and informative policy files remain open", () => {
    expect(validate("methods/grant.schema.json#/$defs/Result", { token: "token" })).toEqual([]);
    for (const file of [undefined, null, 42, { path: "policy" }]) {
      expect(validate("methods/policy.schema.json#/$defs/Result", { state: "open", policy: null, ...(file === undefined ? {} : { file }) })).toEqual([]);
      expect(validate("methods/policy_check.schema.json#/$defs/Result", { allowed: true, reason: null, ...(file === undefined ? {} : { file }) })).toEqual([]);
    }
  });

  test("runner records, views and end results validate their wire shapes", () => {
    expect(validate("methods/spawn_via.schema.json#/$defs/Params", { name: "w", runner: "vm", address: "me/vm/w", machine: "vm" })).toEqual([]);
    expect(validate("methods/spawn_via.schema.json#/$defs/Params", { name: "w" }).length).toBeGreaterThan(0);
    expect(validate("methods/spawn_via.schema.json#/$defs/Result", { recorded: true })).toEqual([]);
    expect(validate("methods/spawn_via.schema.json#/$defs/Result", { recorded: false }).length).toBeGreaterThan(0);
    for (const name of ["EndpointView", "PeekResult"]) {
      const ref = `types.schema.json#/$defs/${name}/properties/runner`;
      expect(validate(ref, { name: "vm", ref: "job-1", attach: "ssh vm", status: { state: "running", detail: "ready", at: "2026-10-24T12:00:00Z" } })).toEqual(
        [],
      );
      expect(validate(ref, { name: "vm" })).toEqual([]);
      expect(validate(ref, { name: "vm", status: { state: "running" } }).length).toBeGreaterThan(0);
    }
    const result = "methods/spawn_end.schema.json#/$defs/Result";
    expect(validate(result, { held: false, runner: { name: "vm", stop: "failed", code: 2, stderr: "reason" } })).toEqual([]);
    expect(validate(result, { held: true, runner: { name: "vm", stop: "stopped" } }).length).toBeGreaterThan(0);
    expect(validate(result, { held: false, runner: { name: "vm", stop: "invalid" } }).length).toBeGreaterThan(0);
  });

  test("limits require exactly the Appendix D broker defaults and allow extensions", () => {
    const table = spec.slice(spec.indexOf("**Broker (`LIMITS`).**"), spec.indexOf("**Other local values.**"));
    const limits = Object.fromEntries([...table.matchAll(/`(\w+)` \| (\d+)/g)].map((match) => [match[1]!, Number(match[2])]));
    const configurable = [...table.slice(0, table.indexOf("| Name |")).matchAll(/`(\w+)`/g)].map((match) => match[1]!).filter((key) => key in limits);
    expect(configurable.sort()).toEqual(["endpointRetireMax", "endpointRetireS", "historicAfterS"]);
    const schema = JSON.parse(readFileSync(join(schemaDir, "types.schema.json"), "utf8")).$defs.Limits;
    expect([...schema.required].sort()).toEqual(Object.keys(limits).sort());
    expect(validate("types.schema.json#/$defs/Limits", { ...limits, engineLimit: 42 })).toEqual([]);
    for (const key of Object.keys(limits)) {
      const missing = { ...limits };
      delete missing[key];
      expect(validate("types.schema.json#/$defs/Limits", missing).length, key).toBeGreaterThan(0);
      const changed = validate("types.schema.json#/$defs/Limits", { ...limits, [key]: limits[key]! + 1 });
      if (configurable.includes(key)) {
        expect(changed, key).toEqual([]);
        expect(validate("types.schema.json#/$defs/Limits", { ...limits, [key]: null }), key).toEqual([]);
        expect(validate("types.schema.json#/$defs/Limits", { ...limits, [key]: 0 }).length, key).toBeGreaterThan(0);
      } else expect(changed.length, key).toBeGreaterThan(0);
    }
  });

  test("requests reject extra fields while error data remains open", () => {
    const request = { jsonrpc: "2.0", id: 1, method: "list", params: {} };
    expect(validate("frames.schema.json#/$defs/Request", request)).toEqual([]);
    expect(validate("frames.schema.json#/$defs/Request", { ...request, extra: true }).length).toBeGreaterThan(0);
    expect(validate("frames.schema.json#/$defs/ErrorObject", { code: -32000, message: "refused", data: { code: "not_found", extra: true } })).toEqual([]);
  });

  test("notifications are fleet events or a hook's revised deadline", () => {
    const notification = "frames.schema.json#/$defs/Notification";
    expect(validate(notification, { jsonrpc: "2.0", method: "hook_deadline", params: { ends: 1_790_000_000_000 } })).toEqual([]);
    expect(validate(notification, { jsonrpc: "2.0", method: "hook_deadline", params: { ends: "soon" } }).length).toBeGreaterThan(0);
    expect(validate(notification, { jsonrpc: "2.0", method: "hook_deadline", params: {} }).length).toBeGreaterThan(0);
    expect(validate(notification, { jsonrpc: "2.0", method: "other", params: {} }).length).toBeGreaterThan(0);
  });

  test("wake clearing is an input and views represent it as null", () => {
    expect(validate("methods/wake.schema.json#/$defs/Params", { via: "none" })).toEqual([]);
    for (const wake of ["channels", "spawn-resume", "hook:vm"]) {
      expect(validate("types.schema.json#/$defs/Wake", wake)).toEqual([]);
    }
    expect(validate("types.schema.json#/$defs/Wake", "none").length).toBeGreaterThan(0);
    for (const ref of ["types.schema.json#/$defs/EndpointView/properties/wake", "methods/whoami.schema.json#/$defs/Result/properties/wake"]) {
      expect(validate(ref, null)).toEqual([]);
      expect(validate(ref, "none").length).toBeGreaterThan(0);
    }
  });

  test("use only the portable keyword subset, and every $ref resolves", () => {
    expect(schemaFiles().flatMap(lint)).toEqual([]);
  });

  test("the index lists exactly the method files", () => {
    const files = readdirSync(join(schemaDir, "methods"))
      .filter((name) => name.endsWith(".schema.json"))
      .map((name) => name.slice(0, -".schema.json".length))
      .sort();
    expect([...methodNames()].sort()).toEqual(files);
  });

  test("every local broker method of SPEC Appendix A has a schema with Params and Result", () => {
    const appendix = spec.slice(spec.indexOf("## Appendix A."), spec.indexOf("## Appendix B."));
    const listed = [...appendix.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]!);
    expect(listed.length).toBeGreaterThan(40);
    expect(listed.filter((method) => !methodNames().includes(method))).toEqual([]);
    for (const method of methodNames()) {
      const file = JSON.parse(readFileSync(join(schemaDir, "methods", `${method}.schema.json`), "utf8"));
      expect(Object.keys(file.$defs ?? {}).sort(), method).toEqual(["Params", "Result"]);
    }
  });

  test("shared types agree with the TS protocol types on field names and optionality", () => {
    const types = JSON.parse(readFileSync(join(schemaDir, "types.schema.json"), "utf8")).$defs as Record<string, { properties?: object; required?: string[] }>;
    const shapes = tsShapes(MIRRORED);
    const drift: string[] = [];
    for (const name of MIRRORED) {
      const shape = shapes.get(name);
      const schema = types[name];
      if (!shape || !schema?.properties) {
        drift.push(`${name}: ${shape ? "no object schema" : "no TS object type"}`);
        continue;
      }
      const keys = Object.keys(schema.properties).sort();
      const required = [...(schema.required ?? [])].sort();
      const onlyTs = shape.keys.filter((key) => !keys.includes(key));
      const onlySchema = keys.filter((key) => !shape.keys.includes(key));
      if (onlyTs.length) drift.push(`${name}: TS only ${onlyTs.join(",")}`);
      if (onlySchema.length) drift.push(`${name}: schema only ${onlySchema.join(",")}`);
      const requiredDiff = shape.required.filter((key) => keys.includes(key) && !required.includes(key));
      const optionalDiff = required.filter((key) => !shape.required.includes(key));
      if (requiredDiff.length) drift.push(`${name}: required in TS, optional in schema ${requiredDiff.join(",")}`);
      if (optionalDiff.length) drift.push(`${name}: optional in TS, required in schema ${optionalDiff.join(",")}`);
    }
    expect(drift).toEqual([]);
  }, 15_000);
});
