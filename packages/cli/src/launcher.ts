import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"

type Env = Record<string, string | undefined>

/** how a harness started without the login shell's PATH runs `swarm`: `argv` is the prefix, `node` the interpreter when it needed one */
export interface Launcher {
  argv: string[]
  node?: string
  /** why `argv` is the bare binary although it is a node script */
  problem?: string
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** the first line of `file` when it starts with `#!` */
function shebang(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const head = Buffer.alloc(256)
    const read = readSync(fd, head, 0, head.length, 0)
    const text = head.subarray(0, read).toString("utf8")
    return text.startsWith("#!") ? text.slice(2).split("\n")[0]!.trim() : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** a per-shell directory that disappears with the shell (fnm's multishells) */
const TRANSIENT = /\/[^/]*multishells?\//

/** a node path that outlives this shell: kept as found (a version manager's shim or Homebrew's link survives upgrades), resolved when it lives in a per-shell directory */
function lasting(node: string): string {
  return TRANSIENT.test(node) ? real(node) : node
}

/** the node a shebang names: an absolute interpreter as is, `env node` (or a bare `node`) the one next to `bin`, else on PATH */
function nodeFor(line: string, bin: string, which: (name: string) => string | undefined): string | undefined {
  const words = line.split(/\s+/).filter(Boolean)
  const program = words[0] ?? ""
  if (basename(program) !== "env" && /^\//.test(program)) return executable(program) ? program : undefined
  const sibling = join(dirname(bin), "node")
  if (executable(sibling)) return sibling
  return which("node")
}

/**
 * The argv prefix that runs `bin` from a GUI app, whose PATH is not the login shell's: a node script (`#!/usr/bin/env node`, as npm,
 * nvm, fnm and Homebrew install `swarm`) runs as absolute node plus the script's real path; anything else (a native build, a Volta
 * shim) runs as `bin` itself.
 */
export function launcher(bin: string, env: Env, which: (name: string) => string | undefined): Launcher {
  const target = real(bin)
  const line = shebang(target)
  if (!line || !/(^|[\s/])node(\s|$)/.test(line)) return { argv: [bin] }
  const node = nodeFor(line, bin, which)
  if (!node) return { argv: [bin], problem: `${bin} is a node script and no node was found next to it or on PATH (${env.PATH ?? ""})` }
  const stable = lasting(node)
  return { argv: [stable, target], node: stable }
}
