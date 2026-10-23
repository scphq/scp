import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { compatDirectory } from "./environment";
import { command } from "./targets";

export const COMPAT_VERSION = "0.11.3";
export const COMPAT_FIXTURE = resolve(import.meta.dir, "../compat");

export async function compatProgram(): Promise<{ program: string[]; cleanup: () => void }> {
  let version: string;
  try {
    version = (await command(["node", "--version"])).trim();
  } catch {
    throw new Error("Pinned broker compatibility requires Node 22.13 or newer on PATH");
  }
  const match = /^v(\d+)\.(\d+)\./.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 13)) {
    throw new Error(`Pinned broker compatibility requires Node 22.13 or newer on PATH (found ${version})`);
  }
  const root = compatDirectory ? resolve(compatDirectory) : mkdtempSync(join(tmpdir(), "scp-compat-"));
  const cleanup = () => {
    if (!compatDirectory) rmSync(root, { recursive: true, force: true });
  };
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
      throw new Error("SCP_COMPAT_DIR must be a directory owned by the current user and not group/world writable");
    }
    const workspacePath = relative(realpathSync(resolve(import.meta.dir, "../../..")), realpathSync(root));
    if (!isAbsolute(workspacePath) && workspacePath !== ".." && !workspacePath.startsWith("../")) {
      throw new Error("SCP_COMPAT_DIR must be outside the workspace");
    }
    const pkg = join(root, "node_modules/@scp-dev/cli");
    const lockfile = readFileSync(join(COMPAT_FIXTURE, "package-lock.json"));
    const installed = () => {
      try {
        return (
          readFileSync(join(root, "package-lock.json")).equals(lockfile) &&
          JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version === COMPAT_VERSION
        );
      } catch {
        return false;
      }
    };
    if (!installed()) {
      for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(COMPAT_FIXTURE, file), join(root, file));
      await command(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], process.env, 120000, root);
    }
    if (!installed()) throw new Error("pinned CLI version or lockfile mismatch");
    return { program: ["node", join(pkg, "dist/cli.js")], cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
