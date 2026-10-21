import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { launcher } from "./launcher"

const SCRIPT = "#!/usr/bin/env node\nimport './main.js'\n"

function put(file: string, content: string, mode = 0o755) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
}

function link(target: string, path: string) {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
}

const root = () => realpathSync(mkdtempSync(join(process.env.HOME!, "launcher-")))
const none = () => undefined

describe("launcher", () => {
  test("an nvm install runs as the node beside it plus the CLI's real script", () => {
    const home = root()
    const bin = join(home, ".nvm/versions/node/v22.13.0/bin")
    const script = join(home, ".nvm/versions/node/v22.13.0/lib/node_modules/@scp-dev/cli/dist/cli.js")
    put(join(bin, "node"), "#!/bin/sh\n")
    put(script, SCRIPT)
    link("../lib/node_modules/@scp-dev/cli/dist/cli.js", join(bin, "swarm"))
    expect(launcher(join(bin, "swarm"), {}, none)).toEqual({ argv: [join(bin, "node"), script], node: join(bin, "node") })
  })

  test("a global npm install without node beside it takes node from PATH, and Homebrew's node link is kept", () => {
    const home = root()
    const script = join(home, ".npm-global/lib/node_modules/@scp-dev/cli/dist/cli.js")
    put(script, SCRIPT)
    link(script, join(home, ".npm-global/bin/swarm"))
    put(join(home, "Cellar/node/22.13.0/bin/node"), "#!/bin/sh\n")
    link(join(home, "Cellar/node/22.13.0/bin/node"), join(home, "homebrew/bin/node"))
    const which = (name: string) => (name === "node" ? join(home, "homebrew/bin/node") : undefined)
    expect(launcher(join(home, ".npm-global/bin/swarm"), {}, which).argv).toEqual([join(home, "homebrew/bin/node"), script])
  })

  test("an fnm multishell, which disappears with its shell, resolves to the installed node and script", () => {
    const home = root()
    const install = join(home, ".local/share/fnm/node-versions/v22.13.0/installation")
    put(join(install, "bin/node"), "#!/bin/sh\n")
    put(join(install, "lib/node_modules/@scp-dev/cli/dist/cli.js"), SCRIPT)
    link(join(install, "lib/node_modules/@scp-dev/cli/dist/cli.js"), join(install, "bin/swarm"))
    link(install, join(home, ".local/state/fnm_multishells/123_456"))
    const shell = join(home, ".local/state/fnm_multishells/123_456/bin")
    expect(launcher(join(shell, "swarm"), {}, none).argv).toEqual([join(install, "bin/node"), join(install, "lib/node_modules/@scp-dev/cli/dist/cli.js")])
  })

  test("a native binary or a Volta shim runs as itself, by the path it was found at", () => {
    const home = root()
    put(join(home, ".volta/bin/volta-shim"), "\u007fELF native")
    link(join(home, ".volta/bin/volta-shim"), join(home, ".volta/bin/swarm"))
    expect(launcher(join(home, ".volta/bin/swarm"), {}, none)).toEqual({ argv: [join(home, ".volta/bin/swarm")] })
    put(join(home, "bin/swarm"), "#!/bin/sh\nexec node cli.js\n")
    expect(launcher(join(home, "bin/swarm"), {}, none)).toEqual({ argv: [join(home, "bin/swarm")] })
  })

  test("a shebang naming an absolute node uses it; a node script with no node anywhere stays as is, with the reason", () => {
    const home = root()
    put(join(home, "opt/node"), "#!/bin/sh\n")
    put(join(home, "a/swarm"), `#!${join(home, "opt/node")}\n`)
    expect(launcher(join(home, "a/swarm"), {}, none).argv).toEqual([join(home, "opt/node"), join(home, "a/swarm")])
    put(join(home, "b/swarm"), SCRIPT)
    const lost = launcher(join(home, "b/swarm"), { PATH: "/usr/bin:/bin" }, none)
    expect(lost.argv).toEqual([join(home, "b/swarm")])
    expect(lost.problem).toContain("no node was found")
  })

  test("a user symlink to an nvm script finds node in the install prefix, and a native binary in an fnm multishell resolves", () => {
    const home = root()
    const prefix = join(home, ".nvm/versions/node/v22.13.0")
    put(join(prefix, "bin/node"), "#!/bin/sh\n")
    put(join(prefix, "lib/node_modules/@scp-dev/cli/dist/cli.js"), SCRIPT)
    link(join(prefix, "lib/node_modules/@scp-dev/cli/dist/cli.js"), join(home, "bin/swarm"))
    expect(launcher(join(home, "bin/swarm"), {}, none).argv).toEqual([join(prefix, "bin/node"), join(prefix, "lib/node_modules/@scp-dev/cli/dist/cli.js")])
    put(join(home, "native/swarm"), "\u007fELF")
    link(join(home, "native"), join(home, "tmp/fnm-multishell-1-2"))
    expect(launcher(join(home, "tmp/fnm-multishell-1-2/swarm"), {}, none).argv).toEqual([join(home, "native/swarm")])
  })
})
