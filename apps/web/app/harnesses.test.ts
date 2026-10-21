import { expect, test } from "bun:test";
import { HARNESS } from "./harnesses";

test("desktop harness names reuse their provider icon paths", () => {
  expect(HARNESS["claude-cowork"].parts).toBe(HARNESS.claude.parts);
  expect(HARNESS["claude-desktop-chat"].parts).toBe(HARNESS.claude.parts);
  expect(HARNESS["claude-desktop"].parts).toBe(HARNESS.claude.parts);
  expect(HARNESS["codex-desktop"].parts).toBe(HARNESS.codex.parts);
  expect(HARNESS["claude-desktop"].label).toBe("Claude Desktop");
  expect(HARNESS["codex-desktop"].label).toBe("Codex desktop");
});
