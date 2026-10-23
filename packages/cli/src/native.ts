import { spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const require = createRequire(import.meta.url)

export function nativeKey(platform = process.platform, arch = process.arch, glibc = linuxGlibc()): string | undefined {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `darwin-${arch}`
  if (platform === "linux" && (arch === "x64" || (arch === "arm64" && glibc))) return `linux-${arch}-${glibc ? "gnu" : "musl"}`
  return undefined
}

function linuxGlibc(): boolean {
  if (process.platform !== "linux") return false
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  return Boolean(header?.glibcVersionRuntime)
}

export function nativeHook(env: Record<string, string | undefined>, version: string): string | undefined {
  try {
    const key = nativeKey()
    const bin = env.SCP_HOOK_BIN !== undefined ? resolve(env.SCP_HOOK_BIN) : key ? require.resolve(`@scp-dev/native-${key}/bin/scp-hook`) : undefined
    if (!bin) return undefined
    accessSync(bin, constants.X_OK)
    if (!statSync(bin).isFile()) return undefined
    const result = spawnSync(bin, ["--version"], { env, encoding: "utf8", timeout: 2000, maxBuffer: 4096 })
    return result.status === 0 && result.stdout === `scp-hook ${version}\n` ? bin : undefined
  } catch {
    return undefined
  }
}
