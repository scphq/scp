#!/usr/bin/env bash
# Two isolated users, each with a broker linked to one org hub: spawn, send, inbox, reply and handback across them.
#
#   E2E_TOKEN_A=scp_t_... E2E_TOKEN_B=scp_t_... scripts/e2e-hosted.sh      the hosted relay (SCP_RELAY, default https://app.scp.dev)
#   SCP_RELAY=http://127.0.0.1:8787 scripts/e2e-hosted.sh                  a local relay: started and seeded when nothing listens
#
# Both tokens must belong to the same org. SWARM overrides the CLI command (default: the CLI from this checkout).
# E2E_KEEP=1 keeps the temp directory. Exit 0 only when every step passes.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY="${SCP_RELAY:-https://app.scp.dev}"
RELAY="${RELAY%/}"
WAIT_S="${E2E_WAIT_S:-60}"
RUN="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/scp-e2e.XXXXXX")"
MACHINE_A="e2e-a-$RUN"
MACHINE_B="e2e-b-$RUN"
read -r -a SWARM_CMD <<<"${SWARM:-bun $ROOT/packages/cli/src/cli.ts}"

case "$RELAY" in
  http://127.0.0.1:* | http://localhost:* | http://127.0.0.1 | http://localhost) LOCAL=1 ;;
  *) LOCAL=0 ;;
esac

PIDS=()
STEPS=()
RESULTS=()
NOTES=()
FAILED=0

redact() { sed -E 's/scp_[A-Za-z]_[A-Za-z0-9_-]+/scp_?_[redacted]/g'; }
log() { printf '%s\n' "$*" | redact >&2; }

record() {
  STEPS+=("$1")
  RESULTS+=("$2")
  NOTES+=("$(printf '%s' "${3:-}" | tr '\n' ' ' | redact | cut -c1-90)")
  [ "$2" = PASS ] || FAILED=1
  log "[$2] $1${3:+: $3}"
}

table() {
  printf '\n%-34s %-6s %s\n' STEP RESULT NOTE
  printf '%-34s %-6s %s\n' "----" "------" "----"
  local i
  for i in "${!STEPS[@]}"; do printf '%-34s %-6s %s\n' "${STEPS[$i]}" "${RESULTS[$i]}" "${NOTES[$i]}"; done
  printf '\n%s against %s\n' "$([ "$FAILED" = 0 ] && echo PASS || echo FAIL)" "$RELAY"
}

cleanup() {
  local pid
  if [ "$LOCAL" = 0 ]; then
    swarm a machines rm "$MACHINE_A" >/dev/null 2>&1
    swarm b machines rm "$MACHINE_B" >/dev/null 2>&1
  fi
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null; done
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do wait "$pid" 2>/dev/null; done
  if [ "${E2E_KEEP:-0}" = 1 ]; then log "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

finish() {
  table
  exit "$FAILED"
}

# a side's environment: its own HOME, config, state and broker socket, nothing of the caller's agent session
side_env() {
  local s="$1" home="$TMP/$1/home"
  printf '%s\n' "PATH=$PATH" "HOME=$home" "TMPDIR=$TMP/$s/tmp" "LANG=${LANG:-C.UTF-8}" "TERM=dumb" \
    "XDG_CONFIG_HOME=$home/.config" "XDG_STATE_HOME=$home/.local/state" "XDG_DATA_HOME=$home/.local/share" \
    "XDG_CACHE_HOME=$home/.cache" "SCP_DIR=$TMP/$s/scp" "SCP_RELAY=$RELAY" "BROWSER=none" \
    "SCP_MACHINE=$([ "$s" = a ] && echo "$MACHINE_A" || echo "$MACHINE_B")"
}

swarm() {
  local s="$1"
  shift
  local envs=()
  while IFS= read -r line; do envs+=("$line"); done < <(side_env "$s")
  env -i "${envs[@]}" "${SWARM_CMD[@]}" "$@" </dev/null
}

json_get() { bun -e 'const v=JSON.parse(await Bun.stdin.text()); const p=process.argv[1].split(".").filter(Boolean); let o=v; for (const k of p) o=o?.[k]; console.log(typeof o==="string"?o:JSON.stringify(o??null))' "$1"; }

for s in a b; do mkdir -p "$TMP/$s/home/.config" "$TMP/$s/home/.local/state" "$TMP/$s/tmp" "$TMP/$s/scp"; done
chmod 700 "$TMP"

# local relay: start one with a throwaway D1 and mint tokens unless both are given
if [ "$LOCAL" = 1 ] && ! curl -fsS --max-time 2 "$RELAY/health" >/dev/null 2>&1; then
  port="${RELAY##*:}"
  case "$port" in http* | "") port=8787 ;; esac
  state="$TMP/relay-state"
  wrangler=("$ROOT/apps/relay/node_modules/.bin/wrangler")
  [ -x "${wrangler[0]}" ] || wrangler=("$ROOT/node_modules/.bin/wrangler")
  (cd "$ROOT/apps/relay" && "${wrangler[@]}" d1 migrations apply scp-relay --local --persist-to "$state" >"$TMP/relay-migrate.log" 2>&1)
  if [ $? -ne 0 ]; then
    record "local relay migrations" FAIL "$(tail -3 "$TMP/relay-migrate.log")"
    finish
  fi
  (cd "$ROOT/apps/relay" && exec "${wrangler[@]}" dev --local --persist-to "$state" --ip 127.0.0.1 --port "$port" \
    --var MAILER:log --var SESSION_SECRET:"e2e-$RUN-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 24)" \
    --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA \
    --show-interactive-dev-session=false >"$TMP/relay.log" 2>&1) &
  PIDS+=("$!")
  for _ in $(seq 1 120); do curl -fsS --max-time 1 "$RELAY/health" >/dev/null 2>&1 && break; sleep 0.5; done
  if ! curl -fsS --max-time 2 "$RELAY/health" >/dev/null 2>&1; then
    record "local relay started" FAIL "$(tail -3 "$TMP/relay.log")"
    finish
  fi
  record "local relay started" PASS "wrangler dev --local on port $port"
  if [ -z "${E2E_TOKEN_A:-}" ] || [ -z "${E2E_TOKEN_B:-}" ]; then
    if out="$(bun "$ROOT/scripts/e2e-local-tokens.ts" "$RELAY" "$TMP/relay.log" "$TMP/token-a" "$TMP/token-b" 2>&1)"; then
      E2E_TOKEN_A="$(cat "$TMP/token-a")"
      E2E_TOKEN_B="$(cat "$TMP/token-b")"
      record "local tokens minted" PASS "$out"
    else
      record "local tokens minted" FAIL "$out"
      finish
    fi
  fi
elif [ "$LOCAL" = 1 ] && { [ -z "${E2E_TOKEN_A:-}" ] || [ -z "${E2E_TOKEN_B:-}" ]; }; then
  record "local relay" FAIL "a relay already listens at $RELAY: stop it so the script starts its own, or pass E2E_TOKEN_A and E2E_TOKEN_B"
  finish
else
  if curl -fsS --max-time 10 "$RELAY/health" >/dev/null 2>&1; then record "relay reachable" PASS "$RELAY/health"; else
    record "relay reachable" FAIL "$RELAY/health did not answer"
    finish
  fi
fi

if [ -z "${E2E_TOKEN_A:-}" ] || [ -z "${E2E_TOKEN_B:-}" ]; then
  record "tokens given" FAIL "set E2E_TOKEN_A and E2E_TOKEN_B to two API tokens of one org (mint them at $RELAY/orgs)"
  finish
fi

# 1. login and link each broker to the hub
ORG_A="" ORG_B=""
for s in a b; do
  token_var="E2E_TOKEN_$(echo "$s" | tr ab AB)"
  envs=()
  while IFS= read -r line; do envs+=("$line"); done < <(side_env "$s")
  if out="$(env -i "${envs[@]}" SCP_TOKEN="${!token_var}" "${SWARM_CMD[@]}" login --json </dev/null 2>&1)"; then
    org="$(printf '%s' "$out" | tail -1 | json_get org)"
    record "login $s" PASS "org $org"
    [ "$s" = a ] && ORG_A="$org" || ORG_B="$org"
  else
    record "login $s" FAIL "$out"
  fi
done
[ "$FAILED" = 0 ] || finish
if [ "$ORG_A" = "$ORG_B" ]; then record "same org" PASS "$ORG_A"; else
  record "same org" FAIL "a is in $ORG_A, b in $ORG_B"
  finish
fi

for s in a b; do
  machine="$([ "$s" = a ] && echo "$MACHINE_A" || echo "$MACHINE_B")"
  if ! out="$(swarm "$s" cloud enable --machine "$machine" 2>&1)"; then
    record "bridge $s" FAIL "$out"
    continue
  fi
  envs=()
  while IFS= read -r line; do envs+=("$line"); done < <(side_env "$s")
  env -i "${envs[@]}" "${SWARM_CMD[@]}" daemon --idle 15m </dev/null >"$TMP/broker-$s.log" 2>&1 &
  PIDS+=("$!")
  connected=""
  for _ in $(seq 1 "$WAIT_S"); do
    status="$(swarm "$s" cloud status --json 2>/dev/null)"
    [ "$(printf '%s' "$status" | json_get broker.connected 2>/dev/null)" = true ] && connected=1 && break
    sleep 1
  done
  if [ -n "$connected" ]; then record "bridge $s" PASS "broker linked as $machine"; else
    record "bridge $s" FAIL "not connected after ${WAIT_S}s: $(printf '%s' "$status" | json_get broker.last_error 2>/dev/null) $(tail -2 "$TMP/broker-$s.log")"
  fi
done
[ "$FAILED" = 0 ] || finish

# 2. b's agent claims its endpoint; a sees it through the hub
swarm b inbox --as bob --json >/dev/null 2>&1
seen=""
for _ in $(seq 1 "$WAIT_S"); do
  swarm a list --as orch --all --json 2>/dev/null | grep -q "\"me/$MACHINE_B/bob\"" && seen=1 && break
  sleep 1
done
if [ -n "$seen" ]; then record "b visible to a" PASS "me/$MACHINE_B/bob"; else
  record "b visible to a" FAIL "me/$MACHINE_B/bob not in a's list after ${WAIT_S}s"
  finish
fi

# 3. a's orchestrator spawns a tiny worker in the background
if out="$(swarm a spawn --as orch --bg --name tiny -- sh -c 'echo "tiny worker result $0"' "$RUN" 2>&1)"; then
  record "spawn worker on a" PASS "$(printf '%s' "$out" | head -1)"
else
  record "spawn worker on a" FAIL "$out"
fi

# 4. a sends to b's endpoint across machines
if out="$(swarm a send --as orch "me/$MACHINE_B/bob" "ping $RUN" --json 2>&1)"; then
  record "send a -> b" PASS "$(printf '%s' "$out" | json_get id)"
else
  record "send a -> b" FAIL "$out"
fi

# 5. b's inbox shows it
ping_id=""
for _ in $(seq 1 $((WAIT_S / 10 + 1))); do
  out="$(swarm b inbox --as bob --wait 10 --json 2>>"$TMP/b-stderr.log")"; printf "%s\n" "$out" >>"$TMP/b-inbox.log"
  ping_id="$(printf '%s' "$out" | bun -e 'const v=JSON.parse(await Bun.stdin.text()); const m=(v.messages??[]).find(m=>String(m.body?.text ?? m.body).includes("ping "+process.argv[1])); console.log(m?m.id+" from "+m.from.address:"")' "$RUN" 2>/dev/null)"
  [ -n "$ping_id" ] && break
done
if [ -n "$ping_id" ]; then record "b inbox shows it" PASS "$ping_id"; else record "b inbox shows it" FAIL "$out"; fi

# 6. b replies in the thread
if [ -n "$ping_id" ] && out="$(swarm b reply --as bob "${ping_id%% *}" "pong $RUN" --json 2>&1)"; then
  record "reply b -> a" PASS "$(printf '%s' "$out" | json_get id)"
else
  record "reply b -> a" FAIL "${out:-no message to reply to}"
fi

# 7. a gets the reply and the worker's handback
got_reply="" got_handback=""
deadline=$((SECONDS + WAIT_S))
while [ $SECONDS -lt $deadline ] && { [ -z "$got_reply" ] || [ -z "$got_handback" ]; }; do
  out="$(swarm a inbox --as orch --wait 10 --json 2>>"$TMP/a-stderr.log")"; printf "%s\n" "$out" >>"$TMP/a-inbox.log"
  found="$(printf '%s' "$out" | bun -e '
    const v = JSON.parse(await Bun.stdin.text())
    for (const m of v.messages ?? []) {
      const body = String(m.body?.text ?? m.body)
      if (body.includes("pong " + process.argv[1])) console.log("reply " + m.id + " from " + m.from.address)
      if (/worker \S*tiny\S* (finished|exited)/.test(body)) console.log("handback " + m.id + " " + body.split("\n")[0])
    }' "$RUN" 2>/dev/null)"
  r="$(printf '%s\n' "$found" | grep '^reply ' | head -1)"
  h="$(printf '%s\n' "$found" | grep '^handback ' | head -1)"
  [ -n "$r" ] && got_reply="${r#reply }"
  [ -n "$h" ] && got_handback="${h#handback }"
done
if [ -n "$got_reply" ]; then record "reply arrives at a" PASS "$got_reply"; else record "reply arrives at a" FAIL "not in a's inbox after ${WAIT_S}s"; fi
if [ -n "$got_handback" ]; then record "handback arrives at a" PASS "$got_handback"; else
  record "handback arrives at a" FAIL "not in a's inbox after ${WAIT_S}s"
fi

finish
