import { spawnSync } from "node:child_process";

const result = spawnSync("bun", ["run", "build"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
