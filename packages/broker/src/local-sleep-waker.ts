/**
 * A reference wake hook for tests: it stands in for a provider that resumes a stopped harness on this machine. It reads the wake event on
 * stdin, claims the endpoint again as the resumed session would (`SCP_WAKE_HANDLE`, against the broker in `SCP_DIR`), drains and acks its
 * inbox, stays up briefly and exits 0. Usage: bun local-sleep-waker.ts <harness> [<file to append the event and the read ids to>]
 */
import { appendFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import type { Envelope } from "@scp-dev/core"
import { RelayClient } from "./client"
import { socketPath } from "./paths"

const [harness = "cli", record] = process.argv.slice(2)
let event = ""
for await (const chunk of process.stdin) event += String(chunk)
const dir = process.env.SCP_DIR
const handle = process.env.SCP_WAKE_HANDLE
if (!dir || !handle) {
  console.error("local-sleep-waker: SCP_DIR and SCP_WAKE_HANDLE are required")
  process.exit(2)
}
if (record) appendFileSync(record, event)
const client = await RelayClient.connect(socketPath(dir))
await client.hello({ claim: { handle, harness } })
const { messages } = await client.request<{ messages: Envelope[] }>("inbox", {})
const seqs = messages.flatMap((m) => (m.seq === undefined ? [] : [m.seq]))
if (seqs.length) await client.request("ack", { seqs })
if (record) appendFileSync(record, `${JSON.stringify({ read: messages.map((m) => m.id) })}\n`)
await sleep(200)
client.close()
