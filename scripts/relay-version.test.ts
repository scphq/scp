import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishTargets } from "./check-publish-targets";
import { checkVersion, relayAnchor, relayRoot, relayVersion, syncVersion } from "./relay-version";

test("relay versions follow the changesets anchor", () => {
  const root = mkdtempSync(join(tmpdir(), "scp-relay-version-"));
  try {
    cpSync(join(relayRoot, "crates"), join(root, "crates"), { recursive: true, filter: (path) => !path.includes("/target") });
    cpSync(join(relayRoot, "packages/dashboard"), join(root, "packages/dashboard"), {
      recursive: true,
      filter: (path) => !path.includes("/dist") && !path.includes("/node_modules"),
    });
    expect(relayVersion(root)).toBe(relayVersion());
    checkVersion(root);
    const edit = (path: string, change: (text: string) => string) => writeFileSync(join(root, path), change(readFileSync(join(root, path), "utf8")));
    edit(relayAnchor, (text) => text.replace(/"version": "[^"]+"/, '"version": "0.2.3"'));
    expect(() => checkVersion(root)).toThrow("versions disagree");
    expect(syncVersion(root)).toBe("0.2.3");
    checkVersion(root);
    const lock = readFileSync(join(root, "crates/Cargo.lock"), "utf8");
    expect(lock).toContain('name = "scp-relay-server"\nversion = "0.2.3"');
    expect(lock).toContain('name = "scp-relay-store"\nversion = "0.2.3"');
    expect(JSON.parse(readFileSync(join(root, "packages/dashboard/package.json"), "utf8")).version).toBe("0.2.3");
    edit("crates/Cargo.lock", (text) => text.replace('name = "scp-relay-store"\nversion = "0.2.3"', 'name = "scp-relay-store"\nversion = "0.0.1"'));
    expect(() => checkVersion(root)).toThrow("versions disagree");
    syncVersion(root);
    const wrapper = "crates/npm/relay-server/package.json";
    edit(wrapper, (text) => text.replace('"@scp-dev/relay-server-darwin-arm64": "0.2.3"', '"@scp-dev/relay-server-darwin-arm64": "0.0.1"'));
    expect(() => checkVersion(root)).toThrow("optionalDependencies");
    syncVersion(root);
    edit("crates/scp-relay/Cargo.toml", (text) => text.replace('version = "=0.2.3"', 'version = "=0.0.1"'));
    expect(() => checkVersion(root)).toThrow("versions disagree");
    edit(relayAnchor, (text) => text.replace(/"version": "[^"]+"/, '"version": "bad"'));
    expect(() => syncVersion(root)).toThrow("X.Y.Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changesets versions the relay anchor but never publishes it", () => {
  const anchor = JSON.parse(readFileSync(join(relayRoot, relayAnchor), "utf8"));
  const config = JSON.parse(readFileSync(join(relayRoot, ".changeset/config.json"), "utf8"));
  const workspaces = JSON.parse(readFileSync(join(relayRoot, "package.json"), "utf8")).workspaces;
  expect(anchor.private).toBe(true);
  expect(workspaces).toContain("crates");
  expect(config.ignore).not.toContain(anchor.name);
  expect(config.privatePackages).toEqual({ version: true, tag: false });
  const targets = publishTargets(relayRoot);
  expect(targets).not.toContain(anchor.name);
  expect(targets).not.toContain("@scp-dev/dashboard");
  expect(targets).toContain("@scp-dev/cli");
});
