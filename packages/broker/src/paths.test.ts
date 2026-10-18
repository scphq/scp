import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { userDatabaseHome } from "./paths"

const ok = (stdout: string) => () => ({ exitCode: 0, stdout })
const fails = () => ({ exitCode: 2, stdout: "" })

describe("userDatabaseHome", () => {
  test("reads dscacheutil on macOS", () => {
    expect(userDatabaseHome(501, { bun: true, platform: "darwin", run: ok("name: ada\nuid: 501\ndir: /home/ada\nshell: /bin/zsh\n") })).toBe("/home/ada")
    expect(userDatabaseHome(501, { bun: true, platform: "darwin", run: fails })).toBeUndefined()
  })

  test("reads getent elsewhere, and /etc/passwd when getent is missing", () => {
    expect(userDatabaseHome(1000, { bun: true, platform: "linux", run: ok("ada:x:1000:1000::/home/ada:/bin/sh\n") })).toBe("/home/ada")
    const passwd = () => "root:x:0:0::/root:/bin/sh\nada:x:1000:1000::/home/ada:/bin/sh\n"
    expect(userDatabaseHome(1000, { bun: true, platform: "linux", run: fails, passwd })).toBe("/home/ada")
    expect(userDatabaseHome(1001, { bun: true, platform: "linux", run: fails, passwd })).toBeUndefined()
  })

  test("the account home comes from the user database, not the HOME the broker starts with", () => {
    const script = `import { accountHome, accountHomeVerified } from ${JSON.stringify(join(import.meta.dir, "paths.ts"))}; console.log(JSON.stringify([accountHome(), accountHomeVerified()]))`
    const result = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, HOME: "/nowhere" }, encoding: "utf8" })
    const [home, verified] = JSON.parse(result.stdout) as [string, boolean]
    expect(home).not.toBe("/nowhere")
    expect(verified).toBe(true)
  })
})
