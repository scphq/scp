import { describe, expect, test } from "bun:test";
import { bumped, cliBumpers, missingCliBump, nativeChanges } from "./native-changeset";

const bumpers = cliBumpers([
  { name: "@scp-dev/cli", dependencies: { "@scp-dev/core": "1", "@scp-dev/broker": "1", "smol-toml": "1" } },
  { name: "@scp-dev/broker", dependencies: { "@scp-dev/core": "1", "@scp-dev/hub": "1" } },
  { name: "@scp-dev/hub", dependencies: { "@scp-dev/core": "1" } },
  { name: "@scp-dev/core" },
  { name: "@scp-dev/spec" },
]);
const files: Record<string, string> = {
  ".changeset/relay-only.md": '---\n"scp-relay": patch\n---\n\nRelay fix.\n',
  ".changeset/spec-only.md": '---\n"@scp-dev/spec": patch\n"scp-relay": patch\n---\n\nSpec.\n',
  ".changeset/cli.md": '---\n"scp-relay": patch\n"@scp-dev/cli": patch\n---\n\nNative fix.\n',
  ".changeset/cli-minor.md": "---\n'@scp-dev/cli': minor\n---\n\nFeature.\n",
  ".changeset/hub.md": '---\n"@scp-dev/hub": patch\n---\n\nHub.\n',
};
const read = (path: string) => files[path] ?? "";
const check = (changeset: string, path = "crates/scp-broker/src/claims.rs") =>
  missingCliBump(
    [
      { status: "M", path },
      { status: "A", path: changeset },
    ],
    read,
    bumpers,
  );

describe("native changeset check", () => {
  test("the CLI's bumpers are the CLI and its transitive workspace dependencies", () => {
    expect([...bumpers].sort()).toEqual(["@scp-dev/broker", "@scp-dev/cli", "@scp-dev/core", "@scp-dev/hub"]);
  });

  test("source and manifests of the native crates count, tests and other crates do not", () => {
    expect(
      nativeChanges([
        { status: "M", path: "crates/scp-broker/src/claims.rs" },
        { status: "M", path: "crates/scp-broker/tests/claims.rs" },
        { status: "M", path: "crates/swarm/Cargo.toml" },
        { status: "M", path: "crates/scp-relay/src/main.rs" },
        { status: "M", path: "crates/scp-broker-extra/src/lib.rs" },
        { status: "M", path: "packages/cli/src/route.ts" },
      ]),
    ).toEqual(["crates/scp-broker/src/claims.rs", "crates/swarm/Cargo.toml"]);
  });

  test("a native change with a changeset outside the CLI's closure is flagged", () => {
    expect(check(".changeset/relay-only.md")).toEqual(["crates/scp-broker/src/claims.rs"]);
    expect(check(".changeset/spec-only.md")).toEqual(["crates/scp-broker/src/claims.rs"]);
  });

  test("a native change that bumps the CLI, directly or through a dependency, passes", () => {
    for (const changeset of [".changeset/cli.md", ".changeset/cli-minor.md", ".changeset/hub.md"]) expect(check(changeset)).toEqual([]);
  });

  test("a changeset modified rather than added does not count", () => {
    expect(
      missingCliBump(
        [
          { status: "M", path: "crates/scp-mcp/src/server.rs" },
          { status: "M", path: ".changeset/cli.md" },
        ],
        read,
        bumpers,
      ),
    ).toEqual(["crates/scp-mcp/src/server.rs"]);
  });

  test("no native change needs no changeset", () => {
    expect(missingCliBump([{ status: "M", path: "crates/scp-relay/src/main.rs" }], read, bumpers)).toEqual([]);
  });

  test("bumped packages are read from the front matter only", () => {
    expect(bumped('---\n"scp-relay": patch\n---\n\n"@scp-dev/cli": patch\n')).toEqual(["scp-relay"]);
    expect(bumped("---\n\"@scp-dev/cli\": patch\n'@scp-dev/core': minor\n---\n")).toEqual(["@scp-dev/cli", "@scp-dev/core"]);
  });
});
