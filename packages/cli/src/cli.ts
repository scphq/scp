#!/usr/bin/env node
import { subagentFastPath } from "./hook-fast"
import { quietSqliteWarning } from "./warnings"

// A subagent hook runs on every tool call, so it leaves before the CLI loads.
if (!(await subagentFastPath(process.argv.slice(2)))) {
  quietSqliteWarning()
  const { run } = await import("./main")
  await run(process.argv.slice(2))
}
