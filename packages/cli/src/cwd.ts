import { homedir } from "node:os"
import { isAbsolute } from "node:path"

/** the working directory, never throwing: when it is gone or access to it was revoked, the first absolute of `fallbacks`, $PWD, HOME, else "/" */
export function safeCwd(fallbacks: (string | undefined)[] = [], env: Record<string, string | undefined> = process.env): string {
  try {
    return process.cwd()
  } catch {}
  const home = () => {
    try {
      return homedir()
    } catch {
      return undefined
    }
  }
  for (const dir of [...fallbacks, env.PWD, env.HOME, home()]) if (dir && isAbsolute(dir)) return dir
  return "/"
}
