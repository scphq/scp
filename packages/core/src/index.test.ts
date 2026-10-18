import { expect, test } from "bun:test";
import { formatAddress } from "./index.ts";

test("formatAddress joins owner and name", () => {
  expect(formatAddress({ owner: "me", name: "agent" })).toBe("me/agent");
});
