# CLI state formats

These schemas freeze the files the `swarm` CLI writes in one invocation and reads in a later one, and the config files it shares with the
broker. They use the same draft 2020-12 keyword subset as `../broker/README.md`. `common.schema.json` holds the shared shapes; every other
`<name>.schema.json` has its fixtures in `fixtures/<name>/`:

- `*.json` (or `*.txt` for a text format) is a valid file the readers take as given;
- `tolerated-*` is a file the schema refuses but a reader still takes, dropping what it cannot use;
- `invalid-*` is a file a reader ignores or refuses as the code does. Malformed JSON is kept as `.txt`.

`packages/cli/src/state-fixtures.test.ts` checks every fixture against its schema, places each where the CLI looks and calls the real reader,
and checks that each writer's output conforms.

Directories: `$SCP_DIR` is the relay directory (`$SCP_DIR`, else `$XDG_STATE_HOME/scp`, else `~/.local/state/scp`). The config directory is
`$XDG_CONFIG_HOME/scp`, else `~/.config/scp`. The policy directory is the directory of the broker's policy file, by default `.config/scp` in the
home directory the user database gives the account (not `$HOME` or `$XDG_CONFIG_HOME`).

"Owned read" below means the reader opens the file with `O_NOFOLLOW | O_NONBLOCK` and ignores it unless it is a regular file owned by the
reading uid (`readOwnedFile`, `read_owned_file`). Every reader that ignores a file also ignores a file it cannot read or parse.

Keyword limits: map keys are constrained in descriptions only (there is no `propertyNames`); reserved handles (`user`, `me`, `relay`), the
`idle_s > 0` bound and cross-field rules are runtime checks.

## claude-bg-mcp-config

- Path: `$SCP_DIR/claude-bg/<16 hex>.json`, and `<short id>.json` beside it, a relative symlink to that file once Claude Code names the session.
  `<short id>` is `^[0-9a-f]{8}$`.
- Writers: `swarm claude --bg` (creates it, mode 0600, then the link); `swarm claude attach --name` (rewrites `SCP_NAME` through the link,
  in place, not atomic); `swarm claude-wake` (`armTicket`: sets or clears `SCP_WAKE_TICKET` and `SCP_HARNESS_ORIGIN`, repairs a gone command,
  via `<file>.<uuid>.tmp` opened `wx` 0600 and renamed over the link's target); a resume under a new short id relinks `<new id>.json` to the
  same file.
- Readers: `readRecords` (claude-bg task, `swarm claude-bg`, `swarm claude-wake`, `swarm relink --check`) follows the link, caches by inode, size and mtime,
  and skips a file it cannot parse; `swarm claude --resume <id>` takes `SCP_NAME`, `SCP_GRANT` and `SCP_UNDER` back from it. Claude Code
  reads it through `--mcp-config`.
- Invariants: only `<short id>.json` names count as records. `SCP_GRANT` and `SCP_UNDER` are always written, empty for none, so the daemon's
  own values never apply; a nonempty one marks the session as parented. Keys outside `mcpServers.scp` are Claude Code's and survive a rewrite.

## claude-bg-state

- Path: `$SCP_DIR/claude-bg/<short id>.state.json`, mode 0600, in a 0700 directory.
- Writers: the claude-bg task (before and after `claude stop` or `claude rm`), `swarm claude-wake` (after a resume, `movedTo` when Claude
  Code resumed under a new short id). Atomic by rename from `<path>.<pid>.<random>.tmp`, a name of this writer alone, opened `wx`.
- Readers: `readState`, `readAllStates` (cached by inode, size and mtime). A file without a string `sessionId` and `cwd` reads as none; other
  fields are taken as they are.
- Invariants: times are epoch milliseconds. A removal clears `rmRefused`; a resume drops `removedAt` and `movedTo`.

## claude-bg-lock

- Path: `$SCP_DIR/claude-bg/<short id>.lock.<pid>.<random>`, mode 0600, one file per run that wants the session, published by rename from
  `.<name>.tmp` so it is never read half written.
- Content: the holder's `pid` and, when `ps -o lstart= -p <pid>` (with `LC_ALL=C`, `TZ=UTC`, `/bin/ps` where it exists) could tell, `started`.
- Writers: every claude-bg run (the broker's task, `swarm claude-bg-task`, `swarm claude prune`, in either engine) publishes its own file before
  it acts on the session, then lists the directory: it holds the session only when no other holder file of the session is live, and unlinks
  its own file after the action, or at once when it does not hold. `swarm claude-wake` takes none: a wake must not wait on a stop.
- Readers: a holder is stale only once its process is verifiably gone: no process has its pid, it is a zombie (`ps -o stat=` starts with
  `Z`), or the one that has it started at another time than `started`. Age never makes it stale. A file it cannot parse takes the pid from its name; one with no usable pid, or whose start
  `ps` cannot read, counts as live. A run unlinks stale holders and never another live one; a listing error is a failure, never a hold.
- Invariants: two runs never hold one session at once, since each lists after it published its file; two at once may both back off, and the
  session waits for the next pass. Node has no `flock`, so the lock needs only `O_EXCL`, `rename`, `readdir` and `unlink`.

## claude-bg-task

- Path: `$SCP_DIR/claude-bg-task.json`, mode 0600.
- Writer and reader: `swarm claude-bg-task`, one run per interval that the native broker starts, never two at once. The run reads it first and
  writes it last, also after a failed run, by rename from `<path>.<pid>.<random>.tmp`; a write error is ignored. The TypeScript broker runs the task
  in process and keeps the same state in memory instead.
- Reader tolerance: a missing or unparseable file is a fresh state; malformed pairs, non-string ids and a non-boolean `listed` are dropped.
- Invariants: Maps and Sets are written as arrays of `[key, value]` pairs and of members. `stopped` values are the entries `claude agents
  --json --all` printed, kept whole.

## claude-bg-ref

- Not a file: the wake ref the claude-bg task hands the broker when it stops a worker, which the broker keeps and passes to the `claude-bg`
  waker (`swarm claude-wake`) as `SCP_WAKE_REF`.
- Form: JSON text of a SPEC 19.1 revive record with `via: "claude-bg"`, or the bare session id when the record would exceed 512 characters.
  `--name` is in `argv` only when the session name matches `^[\w.@+ ][\w.@+ -]{0,99}$`.
- Reader: `refSession`, then `swarm claude-wake` declines (`unresumable`) a ref whose session is not a Claude session id.

## codex-thread-lock

- Path: `$CODEX_HOME/thread-writer-locks/<thread id>.lock` (else `~/.codex/...`). Codex creates and holds it; the CLI never writes it.
- Readers: `codexOwner` (`swarm codex --resume`, `swarm codex-wake`): no file is nobody; else the holders `lsof -t`, then `fuser`, name,
  classified from the process table. The content is never read.
- Invariants: the thread id is a UUID of any version, either case; a name that is not one is no thread.

## shim-binding

- Path: `$SCP_DIR/bindings/pid-<pid>.json`, and `key-<$SCP_SHIM_BINDING>.json` when that is 1 to 128 lowercase hex digits. Mode 0600 in a
  0700 directory.
- Writers: `swarm mcp` for codex, codex-desktop and t3code claims (TypeScript `writeShimBinding`, Rust `write_shim_binding`), again on each
  re-claim. Not atomic: written in place, then chmod 0600. The remover deletes a file only while its content is still the exact text it
  wrote, so every writer must serialize the same bytes: compact JSON, keys in the order `process`, `handle`, `harness`.
- Readers: shell identity in a codex sandbox (`readShimBinding`, `read_shim_binding`): the key file first, else `pid-<pid>` of the first
  ancestor missing from the process table. Owned read.
- Invariants: the process key's pid is above 1 and, in a `pid-` file, equals the file's pid. The harness is one of the three bound
  harnesses and the handle valid.

## session-marker

- Path: `$SCP_DIR/sessions/<first 32 hex digits of sha256(session key)>.json`. The session key is `env:<$SCP_SESSION>`, a process key, or
  `codex:<thread>`; `sub:` keys get no marker.
- Writer: the TypeScript broker on join, rename and leave, by rename from `<path>.<uuid>.tmp`, mode 0600, directory created 0700. The Rust
  broker writes none.
- Readers: hooks and the MCP shim (`membership`, Rust `membership.rs`), `swarm join`. Owned read. A file without a boolean `joined` reads as
  none.
- Invariants: `joined: false` keeps the session off the relay; no marker in manual join mode does too; `handle` is the name a returning
  session claims. An empty handle counts as none.

## muse-launch

- Path: `$SCP_DIR/launch/muse-<pid>.json`, `<pid>` the pid in `process`. Mode 0600 in a 0700 directory.
- Writers: `swarm muse` (`name`, `grant`, `under`) and `swarm spawn` of a muse command (also `session` and `launcher`), once the child has a
  pid; removed when it ends, only while the content is the text written. Not atomic: written in place, then chmod 0600.
- Readers: a muse process's shim and hooks, when they have neither `SCP_NAME` nor `SCP_GRANT` (`readMuseLaunch`, Rust `read_muse_launch`).
  Owned read.
- Invariants: a file whose `process` is not exactly the reader's own process key (a reused pid) is ignored. A field that is not well formed
  is dropped by itself.

## cli-argv

- Path: `$SCP_DIR/cli-argv.json`: a JSON array and a newline, mode 0600.
- Writer: the native broker at start when `$SCP_CLI_ARGV` (which the TypeScript CLI sets to `JSON.stringify(SELF)`) parses to nonempty
  words; by rename from `cli-argv.json.<pid>.tmp`, chmod after the write. No TypeScript reader or writer.
- Reader: the native broker without `$SCP_CLI_ARGV`, for its built-in wakers and tasks. It uses the file only while its first word is an
  absolute path to an executable file and every absolute word exists.

## setup-manifest

- Path: config directory `setup.json`.
- Writer: `swarm setup` after each applied step (and `--undo`), through symlinks, by rename from `.setup.json.tmp-<pid>`; mode 0600 when new,
  else the file's own; no backup. Removed once nothing is left.
- Reader: `swarm setup` at start. A file whose `added` is not a list (an empty file included) stops setup; items without a string
  `harness`, `kind` and `file` are dropped; `version` is not checked.
- Invariants: one item per (harness, kind, file); `rules` accumulates the agy rules setup added.

## claude-version

- Path: config directory `claude-version`: the `x.y.z` of `claude --version` and a newline.
- Writer: `swarm setup` when `claude --version` succeeds. Not atomic, default file mode.
- Readers: the Claude Code stop hook (TypeScript `claudeVersion`, Rust `claude_version`) when the payload names no version, its first 200
  characters, owned read. A version below 2.1.163 does not continue a stop on its context; text without a version does.

## runners

- Path: `$SCP_RUNNERS_FILE`, else policy directory `runners.json`. User written.
- Readers: `swarm spawn --via` (`readRunners`), the broker's runner service (TypeScript `parseRunnerConfig`, Rust `parse_config`) on each use.
  A missing file is no runners; any bad runner refuses the whole file.
- Invariants: names `^[a-z0-9][a-z0-9-]{0,31}$`; `timeout_s` 1 to 3600 (null or absent 60); `status_timeout_s` 1 to 60 (absent 5, null
  refused); unknown fields ignored.

## wakers

- Path: policy directory `wakers.json`. User written; no variable moves it.
- Reader: the broker (TypeScript `parseWakers`, Rust `parse_wakers`), again whenever its mtime or size changes. A malformed file configures
  no waker, logged; the built-in wakers (`spawn`, `codex-queue`, `claude-bg`) stay unless the file names their provider.
- Invariants: providers `^[a-z0-9][a-z0-9-]{0,31}$`; `command` nonempty words; `timeout_s` whole seconds 1 to 3600, null or absent 60.

## hold-ref

- Not a file: the wake `ref` that `swarm spawn --durable` gives the broker with wake `spawn-resume`, which the broker keeps and hands
  `swarm spawn-wake` in the wake request (`ref`, else `SCP_WAKE_REF`).
- Writer: `durableRef`, with the program resolved to an absolute path. The text is at most 512 characters, without control characters or
  anything that looks like a credential, and never carries the grant.
- Reader: `parseHoldRef`; `swarm spawn-wake` declines (`unresumable`) a ref it refuses or whose `cwd` is not a directory.
- Invariants: the basename of `argv`'s program is `harness`; `idle_s` above 0, null for no limit.

## config

- Path: config directory `config.json`.
- Writers: `swarm relay use` (`relay`) and `swarm setup --join ... --write` (`join`), by rename from `.<uuid>.tmp` opened `wx`, mode 0600,
  directory 0700, other keys kept. The user writes the rest.
- Readers: `joinMode` (hooks, shim; Rust `manual_join`), the claude-bg settings (`bgConfig`, `spawnIdleAfterS`, `historicAfterS`; Rust
  `historic_after_s`), `activeRelay` (TypeScript and Rust), the TypeScript broker's `limits`. Owned read except `activeRelay` and `limits`.
- Reader tolerance: the join and idle readers take a file that is not an object as empty; `activeRelay` and `limits` refuse it.
- Invariants: environment variables (`SCP_RELAY`, `SCP_CLAUDE_BG_*`, `SCP_SPAWN_IDLE_AFTER_S`, `SCP_IDLE_AFTER_S`, `SCP_HISTORIC_AFTER_S`)
  win over the file. Seconds take a number, a numeric string, a duration or `Infinity`; `historic_after_s` 0 is the broker default.

## credentials

- Path: config directory `credentials.json`.
- Writers: `swarm login` (`saveCredential`, with `saved_at` now), `swarm logout`; as for config.json.
- Readers: `relayCredential` (CLI, TypeScript and Rust bridge), `readCredentials`. One entry without a nonblank `token` and a string
  `saved_at` refuses the whole file.
- Invariants: keys are relay origins as `checkRelayUrl` normalizes them; `SCP_TOKEN` wins over the file.

## cloud

- Path: config directory `cloud.json`.
- Writer: `swarm cloud enable` writes `{bridge, machine, url}` as for config.json; `swarm cloud disable` removes it.
- Readers: the broker at start (`readCloudFile`, Rust `read_cloud_file`), `swarm cloud status`. A file it refuses leaves the broker
  local-only.
- Invariants: `machine` is not `me`; a missing `url` is the active relay; `mirror` holds at most 256 selectors, none of them a scope selector.
