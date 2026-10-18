import { defineConfig } from "tsup"

export default defineConfig({
  entry: { cli: "src/cli.ts", "pi-extension": "../pi/src/index.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["@mariozechner/pi-coding-agent", "@earendil-works/pi-coding-agent"],
  clean: true,
})
