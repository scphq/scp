import { join } from "node:path"
import type { LinkFactory } from "@scp-dev/broker"
import { ACCOUNT_KEY_FILE, meshDir, readAccountKey, readConfig, readMachineKey } from "./config"
import { startMesh } from "./link"

export async function meshBrokerOptions(dir: string = meshDir()): Promise<{ machine?: string; link?: LinkFactory }> {
  const config = readConfig(dir)
  if (!config?.enabled) return {}
  const account = readAccountKey(dir)
  const machineKey = readMachineKey(dir)
  if (account.account !== config.account) throw new Error(`${join(dir, ACCOUNT_KEY_FILE)} is for account ${account.account}, not ${config.account}`)
  return {
    machine: config.machine,
    link: (context) =>
      startMesh({
        ...context,
        config,
        account,
        machineKey,
        reloadConfig: () => {
          try {
            return readConfig(dir)
          } catch {
            return null
          }
        },
      }),
  }
}
