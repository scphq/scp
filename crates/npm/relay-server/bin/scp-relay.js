#!/usr/bin/env node
const { spawn } = require("node:child_process");

let binary = process.env.SCP_RELAY_BINARY;
if (!binary) {
  let key = `${process.platform}-${process.arch}`;
  if (process.platform === "linux") {
    key += process.report.getReport().header.glibcVersionRuntime ? "-gnu" : "-musl";
  }
  const name = `@scp-dev/relay-server-${key}`;
  try {
    binary = require.resolve(`${name}/bin/scp-relay${process.platform === "win32" ? ".exe" : ""}`);
  } catch {
    console.error(`Missing relay binary package ${name}. Install with optional dependencies enabled on a supported platform, or set SCP_RELAY_BINARY.`);
    process.exit(1);
  }
}
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`Cannot start SCP relay: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exitCode = code ?? 1;
});
