import { expect, test } from "bun:test";
import { safeNext } from "../src/util.ts";

test("safeNext keeps local paths and refuses anything a browser could send off-origin", () => {
  expect(safeNext("/orgs/a?b=1#c")).toBe("/orgs/a?b=1#c");
  for (const bad of ["//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "https://evil.example", "", null]) {
    expect(safeNext(bad)).toBe("/orgs");
  }
});
