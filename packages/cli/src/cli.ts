#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };

const usage = `swarm ${pkg.version}

Usage: swarm <command>

Commands:
  help       Show this message
  version    Print the version`;

const command = process.argv[2];

if (command === "version" || command === "--version" || command === "-v") {
  console.log(pkg.version);
} else {
  console.log(usage);
}
