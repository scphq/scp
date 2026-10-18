import { expect, test } from "bun:test"
import { piLaunch } from "./pi"

test("swarm pi names the session, marks the harness pi and passes the rest to pi with the extension", () => {
  const launch = piLaunch(["--name", "me/demo", "--", "--name", "x", "-c"], { PATH: "/bin" }, "/ext/index.ts")
  expect(launch.argv).toEqual(["pi", "--extension", "/ext/index.ts", "--name", "x", "-c"])
  expect(launch.env).toEqual({ PATH: "/bin", SCP_HARNESS: "pi", SCP_NAME: "demo" })
  expect(piLaunch(["--as=demo", "--continue"], { SCP_PI_BIN: "/opt/pi" }, "/e").argv).toEqual(["/opt/pi", "--extension", "/e", "--continue"])
  expect(piLaunch([], {}, "/e").env.SCP_NAME).toBeUndefined()
  expect(() => piLaunch(["--name", "Bad Name"], {}, "/e")).toThrow("not a valid agent handle")
  expect(() => piLaunch(["--name"], {}, "/e")).toThrow("takes a name")
})
