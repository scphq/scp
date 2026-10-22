import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nativeKeys, nativeVersion } from "../../scripts/native-version";

export function nativePackage(key: string, binary: string, outdir: string) {
  if (!nativeKeys.some((value) => value === key)) throw new Error(`Unsupported platform: ${key}`);
  const [os, cpu, libc] = key.split("-");
  mkdirSync(join(outdir, "bin"), { recursive: true });
  const destination = join(outdir, "bin", "scp-hook");
  copyFileSync(binary, destination);
  chmodSync(destination, 0o755);
  writeFileSync(
    join(outdir, "package.json"),
    `${JSON.stringify(
      {
        name: `@scp-dev/native-${key}`,
        version: nativeVersion(),
        description: `SCP hook binary for ${key}`,
        os: [os],
        cpu: [cpu],
        ...(libc ? { libc: [libc === "gnu" ? "glibc" : libc] } : {}),
        files: ["bin", "README.md"],
        license: "Apache-2.0",
        repository: { type: "git", url: "https://github.com/scphq/scp.git", directory: "crates/npm" },
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(outdir, "README.md"), `Native SCP hook binary for ${key}. See https://scp.dev/docs.\n`);
}
if (import.meta.main) {
  const [key, binary, outdir] = process.argv.slice(2);
  if (!key || !binary || !outdir) throw new Error("Usage: bun crates/npm/native.ts <key> <binary> <outdir>");
  nativePackage(key, resolve(binary), resolve(outdir));
}
