import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { homedir, hostname, userInfo } from "node:os"
import { join } from "node:path"

type Run = (cmd: string[]) => { exitCode: number | null; stdout: string | Buffer }

const runQuiet: Run = (cmd) => {
  const result = spawnSync(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 })
  return { exitCode: result.status, stdout: result.stdout ?? "" }
}

/** macOS's LocalHostName (read only), or undefined when it is unset */
export function localHostName(run: Run = runQuiet): string | undefined {
  try {
    const result = run(["scutil", "--get", "LocalHostName"])
    return (result.exitCode === 0 && result.stdout.toString().trim()) || undefined
  } catch {
    return undefined
  }
}

/** this machine's name: on macOS its LocalHostName, which a network change does not rename as it can the hostname; else the hostname */
export function systemHostname(
  platform: string = process.platform,
  local: () => string | undefined = localHostName,
  fallback: () => string = hostname,
): string {
  return (platform === "darwin" && local()) || fallback()
}

let host: string | undefined

/** systemHostname, read once per process */
export function thisHostname(): string {
  host ??= systemHostname()
  return host
}

/** the lowercased first label of `name` (default this machine's): agents' machine label, and what `machine:` matches */
export function shortHostname(name: string = thisHostname()): string {
  return (name.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "unknown"
}

/** `$SCP_DIR`, else `$XDG_STATE_HOME/scp`, else ~/.local/state/scp */
export function relayDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SCP_DIR) return env.SCP_DIR
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "scp")
}

/**
 * `~/.config/scp/policy.json` of the account the broker runs as, from the user database rather
 * than HOME or XDG_CONFIG_HOME, so the process that happens to start the broker cannot pick its policy
 */
export function policyPath(): string {
  return join(accountHome(), ".config", "scp", "policy.json")
}

let home: string | undefined
let verified = false

/** whether accountHome came from the user database rather than HOME */
export function accountHomeVerified(): boolean {
  accountHome()
  return verified
}

/**
 * the home directory the user database holds for `uid`. Node's userInfo reads it with getpwuid; Bun's answers from HOME,
 * so under Bun it comes from the system's directory tools instead: dscacheutil on macOS, getent or /etc/passwd elsewhere
 */
export function userDatabaseHome(uid: number, options: { platform?: string; bun?: boolean; run?: Run; passwd?: () => string } = {}): string | undefined {
  const platform = options.platform ?? process.platform
  if (!(options.bun ?? typeof process.versions.bun === "string")) return userInfo().homedir || undefined
  const run = options.run ?? runQuiet
  if (platform === "darwin") {
    const result = run(["dscacheutil", "-q", "user", "-a", "uid", String(uid)])
    return (result.exitCode === 0 && /^dir: (.+)$/m.exec(result.stdout.toString())?.[1]?.trim()) || undefined
  }
  const entry = (text: string) => text.split("\n").find((line) => line.split(":")[2] === String(uid))
  const result = run(["getent", "passwd", String(uid)])
  let line = result.exitCode === 0 ? entry(result.stdout.toString()) : undefined
  if (!line) {
    try {
      line = entry((options.passwd ?? (() => readFileSync("/etc/passwd", "utf8")))())
    } catch {}
  }
  return line?.split(":")[5] || undefined
}

/** the account's home directory from the user database, falling back to HOME where that is unavailable */
export function accountHome(): string {
  if (home) return home
  try {
    if (typeof process.getuid === "function") home = userDatabaseHome(process.getuid())
    verified = Boolean(home)
  } catch {}
  home ||= homedir()
  return home
}

const SUN_PATH_MAX = 100

/** a private directory: created 0700, and refused when it is a link or someone else's */
export function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`${path} is not a directory this user owns`)
  }
  chmodSync(path, 0o700)
  return path
}

/** whether `path` is a directory of this user's, not a link, that nobody else may write: where a socket can be trusted */
export function ownPrivateDir(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  return !!stat && stat.isDirectory() && (typeof process.getuid !== "function" || stat.uid === process.getuid()) && (stat.mode & 0o022) === 0
}

/**
 * The broker's socket: inside the relay dir, unless that path is too long for a unix socket
 * (deep temp HOMEs), then a per-user, per-dir private directory under /tmp.
 */
export function socketPath(dir: string): string {
  const inside = join(dir, "relay.sock")
  if (Buffer.byteLength(inside) <= SUN_PATH_MAX) return inside
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  const key = createHash("sha256").update(dir).digest("hex").slice(0, 12)
  return join("/tmp", `scp-${uid}-${key}`, "relay.sock")
}
