import { join } from "node:path";
const cli = join(import.meta.dir, "../../cli/dist/cli.js");
import { terminate } from "./targets";

const env = JSON.parse(await Bun.file(process.argv[2]!).text()) as Record<string, string>;
const request = (await Bun.stdin.json()) as { name: string; cmd: string[]; cwd: string; join: { under: string; mode: string } };
if (request.join.mode !== "account") throw new Error("runner requires account mode");
const child = Bun.spawn(
  [process.execPath, "--no-env-file", cli, "spawn", "--fg", "--name", request.name, "--under", request.join.under, "--", ...request.cmd],
  {
    env,
    cwd: request.cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  },
);
process.once("SIGTERM", () => void terminate(child));
const stderr = await new Response(child.stderr).text();
const code = await child.exited;
if (code !== 0) {
  console.error(stderr);
  process.exit(code);
}
console.log(JSON.stringify({ machine: env.SCP_MACHINE, address: `me/${env.SCP_MACHINE}/${request.name}` }));
