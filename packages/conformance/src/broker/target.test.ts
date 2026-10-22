import { expect, test } from "bun:test";
import { socketPath } from "./target";

test("socket discovery keeps paths of at most 100 bytes in the relay directory", () => {
  const dir = `/${"a".repeat(88)}`;
  expect(Buffer.byteLength(`${dir}/relay.sock`)).toBe(100);
  expect(socketPath(dir)).toBe(`${dir}/relay.sock`);
});

test("socket discovery hashes paths over 100 bytes, counting UTF-8 bytes", () => {
  expect(socketPath(`/${"a".repeat(89)}`)).toBe(`/tmp/scp-${process.getuid!()}-215c7631b57b/relay.sock`);
  expect(socketPath(`/${"é".repeat(45)}`)).toBe(`/tmp/scp-${process.getuid!()}-11e4519eb572/relay.sock`);
});
