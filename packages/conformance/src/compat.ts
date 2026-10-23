import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { compatDirectory } from "./environment";
import { command } from "./targets";

export const COMPAT_VERSION = "0.11.3";

export async function compatProgram(): Promise<string[]> {
  const root = resolve(compatDirectory ?? join(tmpdir(), `scp-compat-${COMPAT_VERSION}`));
  const workspacePath = relative(resolve(import.meta.dir, "../../.."), root);
  if (!isAbsolute(workspacePath) && workspacePath !== ".." && !workspacePath.startsWith("../")) {
    throw new Error("SCP_COMPAT_DIR must be outside the workspace");
  }
  const pkg = join(root, "node_modules/@scp-dev/cli");
  const installed = () => {
    try {
      return JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version === COMPAT_VERSION;
    } catch {
      return false;
    }
  };
  if (!installed()) {
    mkdirSync(root, { recursive: true });
    await command(
      ["npm", "install", "--prefix", root, "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", `@scp-dev/cli@${COMPAT_VERSION}`],
      process.env,
      120000,
    );
  }
  if (!installed()) throw new Error("pinned CLI version mismatch");
  return ["node", join(pkg, "dist/cli.js")];
}
