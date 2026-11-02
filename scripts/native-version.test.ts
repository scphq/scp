import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativePackage } from "../crates/npm/native";
import { publishTargets } from "./check-publish-targets";
import { checkVersion, nativeNames, nativeRoot, nativeVersion, syncVersion } from "./native-version";

test("native packages stay pinned to the CLI version", () => {
  checkVersion();
  const root = mkdtempSync(join(tmpdir(), "scp-native-version-"));
  try {
    mkdirSync(join(root, "packages/cli"), { recursive: true });
    const file = join(root, "packages/cli/package.json");
    writeFileSync(file, JSON.stringify({ version: "0.2.3" }));
    expect(() => checkVersion(root)).toThrow("optionalDependencies");
    expect(syncVersion(root)).toBe("0.2.3");
    checkVersion(root);
    const cli = JSON.parse(readFileSync(file, "utf8"));
    cli.optionalDependencies[nativeNames[0]!] = "0.0.1";
    writeFileSync(file, JSON.stringify(cli));
    expect(() => checkVersion(root)).toThrow("optionalDependencies");
    for (const name of nativeNames) expect(publishTargets(nativeRoot)).toContain(name);
    const hook = join(root, "scp-hook");
    const swarm = join(root, "swarm");
    writeFileSync(hook, "hook fixture");
    writeFileSync(swarm, "swarm fixture");
    const out = join(root, "pkg");
    nativePackage("linux-x64-gnu", { hook, swarm }, out);
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "@scp-dev/native-linux-x64-gnu", version: nativeVersion(), os: ["linux"], cpu: ["x64"], libc: ["glibc"] });
    expect(readFileSync(join(out, "bin/scp-hook"), "utf8")).toBe("hook fixture");
    expect(readFileSync(join(out, "bin/swarm"), "utf8")).toBe("swarm fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
