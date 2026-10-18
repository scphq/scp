import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("a command that exits right after printing a large result hands all of it to a pipe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-exit-"))
  try {
    const script = join(dir, "print.ts")
    const output = new URL("./term.ts", import.meta.url).pathname
    writeFileSync(
      script,
      `import { exitFlushed } from ${JSON.stringify(output)}\nprocess.stdout.write("x".repeat(1_000_000) + "\\n")\nprocess.stderr.write("y".repeat(300_000))\nawait exitFlushed(3)\n`,
    )
    const child = Bun.spawn(["sh", "-c", `bun "$0" 2> "$0.err" | wc -c`, script], { stdout: "pipe" })
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(Number(out.trim().split("\n")[0])).toBe(1_000_001)
    expect((await Bun.file(`${script}.err`).text()).length).toBe(300_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
