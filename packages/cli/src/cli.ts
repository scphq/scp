#!/usr/bin/env node
import { quietSqliteWarning } from "./warnings"

quietSqliteWarning()
const { run } = await import("./main")
await run(process.argv.slice(2))
