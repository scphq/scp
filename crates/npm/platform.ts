import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platformKeys, relayVersion } from "../../scripts/relay-version";

export function platformPackage(key: string, binary: string, outdir: string) {
  if (!platformKeys.some((value) => value === key)) throw new Error(`Unsupported platform: ${key}`);
  const [os, cpu, libc] = key.split("-");
  mkdirSync(join(outdir, "bin"), { recursive: true });
  const destination = join(outdir, "bin", os === "win32" ? "scp-relay.exe" : "scp-relay");
  copyFileSync(binary, destination);
  chmodSync(destination, 0o755);
  writeFileSync(
    join(outdir, "package.json"),
    `${JSON.stringify(
      {
        name: `@scp-dev/relay-server-${key}`,
        version: relayVersion(),
        description: `SCP relay binary for ${key}`,
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
  writeFileSync(join(outdir, "README.md"), `Native SCP relay binary for ${key}. See https://scp.dev/docs/self-host.\n`);
}
if (import.meta.main) {
  const [key, binary, outdir] = process.argv.slice(2);
  if (!key || !binary || !outdir) throw new Error("Usage: bun crates/npm/platform.ts <key> <binary> <outdir>");
  platformPackage(key, resolve(binary), resolve(outdir));
}
