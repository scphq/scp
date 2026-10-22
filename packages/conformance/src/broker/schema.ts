import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Schema = { [key: string]: unknown } | boolean;

export const schemaDir = join(import.meta.dir, "../../../spec/schema/broker");
export const KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "oneOf",
  "anyOf",
  "format",
]);

const files = new Map<string, Record<string, unknown>>();
function load(file: string): Record<string, unknown> {
  let found = files.get(file);
  if (!found) {
    found = JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as Record<string, unknown>;
    files.set(file, found);
  }
  return found;
}

export function schemaFiles(): string[] {
  const methods = readdirSync(join(schemaDir, "methods")).filter((name) => name.endsWith(".schema.json"));
  return ["frames.schema.json", "types.schema.json", ...methods.map((name) => `methods/${name}`)];
}
export function methodNames(): string[] {
  return (load("index.json") as { methods: string[] }).methods;
}
export function hasMethod(method: string) {
  return methodNames().includes(method);
}

/** every keyword outside the portable subset, and every $ref that does not resolve */
export function lint(file: string): string[] {
  const problems: string[] = [];
  const walk = (node: unknown, path: string, keyed: boolean) => {
    if (Array.isArray(node))
      return node.forEach((item, i) => {
        walk(item, `${path}/${i}`, false);
      });
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (keyed) {
        walk(value, `${path}/${key}`, false);
        continue;
      }
      if (!KEYWORDS.has(key)) problems.push(`${file}${path}: keyword ${key}`);
      if (key === "format" && value !== "date-time") problems.push(`${file}${path}: format ${String(value)}`);
      if (key === "$ref") {
        try {
          resolve(file, value as string);
        } catch (error) {
          problems.push(`${file}${path}: ${(error as Error).message}`);
        }
      }
      if (key === "enum" || key === "const" || key === "required" || key === "type") continue;
      walk(value, `${path}/${key}`, key === "properties" || key === "$defs");
    }
  };
  walk(load(file), "", false);
  return problems;
}

function resolve(from: string, ref: string): { file: string; schema: Schema } {
  const [target = "", pointer = ""] = ref.split("#");
  const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const file = target ? join(base, target).replace(/^\.\//, "") : from;
  let node: unknown = load(file);
  for (const part of pointer.split("/").filter(Boolean)) {
    node = (node as Record<string, unknown> | undefined)?.[part];
    if (node === undefined) throw new Error(`unresolved $ref ${ref} from ${from}`);
  }
  return { file, schema: node as Schema };
}

const typeOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value);
const typeMatches = (want: string, value: unknown) => {
  const got = typeOf(value);
  return want === got || (want === "number" && got === "integer");
};
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validDateTime(value: string): boolean {
  if (!DATE_TIME.test(value)) return false;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59) return false;
  const offset = value.match(/[+-](\d{2}):(\d{2})$/);
  return !offset || (Number(offset[1]) <= 23 && Number(offset[2]) <= 59);
}

function check(file: string, schema: Schema, value: unknown, path: string, errors: string[]) {
  if (schema === true) return;
  if (schema === false) return void errors.push(`${path}: not allowed`);
  if (typeof schema.$ref === "string") {
    const target = resolve(file, schema.$ref);
    check(target.file, target.schema, value, path, errors);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((want) => typeMatches(want, value))) return void errors.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string") {
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && !validDateTime(value)) errors.push(`${path}: not a date-time`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined)
      value.forEach((item, i) => {
        check(file, schema.items as Schema, item, `${path}/${i}`, errors);
      });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in record)) errors.push(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(record)) {
      if (item === undefined) continue;
      if (key in properties) check(file, properties[key]!, item, `${path}/${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        check(file, schema.additionalProperties as Schema, item, `${path}/${key}`, errors);
    }
  }
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const options = schema[keyword] as Schema[] | undefined;
    if (!options) continue;
    const failures = options.map((option) => {
      const inner: string[] = [];
      check(file, option, value, path, inner);
      return inner;
    });
    const passed = failures.filter((inner) => inner.length === 0).length;
    if (keyword === "anyOf" ? passed === 0 : passed !== 1) {
      const nearest = failures.reduce((best, inner) => (inner.length && inner.length < best.length ? inner : best), failures[0] ?? []);
      errors.push(`${path}: ${passed} of ${options.length} ${keyword} branches match${passed ? "" : `, nearest: ${nearest.slice(0, 3).join("; ")}`}`);
    }
  }
}

/** the problems of `value` against `ref` (a file plus pointer, as "types.schema.json#/$defs/Envelope"); empty when it conforms */
export function validate(ref: string, value: unknown): string[] {
  const target = resolve("", ref);
  const errors: string[] = [];
  check(target.file, target.schema, value, "", errors);
  return errors;
}
export const methodRef = (method: string, part: "Params" | "Result") => `methods/${method}.schema.json#/$defs/${part}`;

/** Validate an inline schema with references relative to a schema file. */
export function validateSchema(schema: Schema, value: unknown, file = "types.schema.json"): string[] {
  const errors: string[] = [];
  check(file, schema, value, "", errors);
  return errors;
}
