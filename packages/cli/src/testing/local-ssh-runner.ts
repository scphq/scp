/**
 * A reference runner: reads the spawn request on stdin and starts `swarm spawn --name N --under <parent> -- <cmd>` against another relay dir
 * (`--dir`), standing in for a remote machine bridged to the same account, as an ssh runner would run it on the remote host.
 * Exits with the remote spawn's exit code, which returns once the harness started; with `--machine` it then prints the worker's address.
 */
import { spawn } from "node:child_process"
import { join } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({ options: { dir: { type: "string" }, machine: { type: "string" } }, strict: true })
if (!values.dir) {
  console.error("local-ssh-runner: --dir names the remote machine's relay dir")
  process.exit(2)
}

const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  name: string
  title: string | null
  cmd: string[]
  cwd: string
  labels: Record<string, string>
  join: { under: string; name: string; mode: string }
}
if (request.join.mode !== "account") {
  console.error(`local-ssh-runner: join mode ${request.join.mode} is not supported`)
  process.exit(2)
}

const labels = Object.entries(request.labels).map(([key, value]) => `${key}=${value}`)
const cli = join(import.meta.dirname, "..", "cli.ts")
const child = spawn(
  process.execPath,
  [
    "--no-env-file",
    cli,
    "spawn",
    "--bg",
    "--name",
    request.join.name,
    "--under",
    request.join.under,
    ...(request.title ? ["--title", request.title] : []),
    ...(labels.length ? ["--labels", labels.join(",")] : []),
    "--",
    ...request.cmd,
  ],
  { cwd: request.cwd, env: { ...process.env, SCP_DIR: values.dir }, stdio: ["ignore", "ignore", "pipe"] },
)
let stderr = ""
child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
child.once("exit", (code) => {
  if (code !== 0) process.stderr.write(stderr)
  else if (values.machine) process.stdout.write(`${JSON.stringify({ address: `me/${values.machine}/${request.join.name}`, machine: values.machine })}\n`)
  process.exit(code ?? 1)
})
