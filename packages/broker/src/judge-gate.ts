import { accessSync, constants, readFileSync } from "node:fs"
import { JudgeGate as HubJudgeGate, type JudgeGateOptions } from "@scp-dev/hub"

export type { Deliver, HoldView, JudgeClientFactory, JudgeGateOptions } from "@scp-dev/hub"

/** a key file read at each call, or null while it is not readable */
export function readKeyFile(file: string): (() => Promise<string>) | null {
  try {
    accessSync(file, constants.R_OK)
  } catch {
    return null
  }
  return async () => readFileSync(file, "utf8").trim()
}

/** the hub's judge gate reading `key_file` keys from disk */
export class JudgeGate extends HubJudgeGate {
  constructor(options: JudgeGateOptions) {
    super({ keyFile: readKeyFile, ...options })
  }
}
