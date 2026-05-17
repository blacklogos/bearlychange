#!/usr/bin/env bash
# Smoke test for bearlychange on Cloudflare Workers + D1. Boots
# `wrangler dev` with a throwaway local D1 state dir, applies the migration,
# exercises the public + admin + CLI surface, and reports a pass/fail
# summary. Exit 0 if all pass, 1 otherwise.
#
# Run via `npm test` or `bash tests/smoke.sh`.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${BEARLYCHANGE_TEST_PORT:-8787}"
ADMIN_USER="admin"
ADMIN_PASS="smoke-test-$$"
ADMIN_TOKEN="smoke-token-$$-$RANDOM"
BASE="http://localhost:$PORT"
WRANGLER_STATE="$(mktemp -d -t bc-wrangler.XXXXXX)"
SERVER_LOG="$(mktemp -t bc-smoke-log.XXXXXX).log"

# Default CLI auth path = Basic so existing assertions exercise it. Bearer
# assertions explicitly override BEARLYCHANGE_TOKEN inline below.
export BEARLYCHANGE_URL="$BASE"
export BEARLYCHANGE_USER="$ADMIN_USER"
export BEARLYCHANGE_PASS="$ADMIN_PASS"

PASS=0
FAIL=0
FAILURES=()

green() { printf "\033[32m%s\033[0m" "$1"; }
red() { printf "\033[31m%s\033[0m" "$1"; }
bold() { printf "\033[1m%s\033[0m" "$1"; }

pass() { PASS=$((PASS + 1)); printf "  %s %s\n" "$(green '✓')" "$1"; }
fail() {
  FAIL=$((FAIL + 1)); FAILURES+=("$1")
  printf "  %s %s\n" "$(red '✗')" "$1"
  [[ $# -gt 1 ]] && printf "      %s\n" "$2"
}
step() { printf "\n%s\n" "$(bold "$1")"; }

# Tiny JSON probe — runs a node one-liner against the JSON on stdin.
json_eval() {
  node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);const r=eval('o.$1');process.stdout.write(r===undefined?'__undefined__':String(r))}catch(e){process.stdout.write('__err__')}})"
}

assert_http() {
  local expected="$1"; shift
  local label="HTTP $expected ${*: -1}"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$@")"
  if [[ "$code" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label" "got $code"
  fi
}

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  # wrangler dev forks workerd; reap any orphaned children of ours.
  pkill -P $$ wrangler 2>/dev/null || true
  pkill -P $$ workerd 2>/dev/null || true
  rm -rf "$WRANGLER_STATE" "$SERVER_LOG"
}
trap cleanup EXIT

if command -v lsof >/dev/null 2>&1; then
  EXISTING="$(lsof -ti ":$PORT" 2>/dev/null || true)"
  if [[ -n "$EXISTING" ]]; then
    echo "port $PORT already in use (pid $EXISTING); set BEARLYCHANGE_TEST_PORT or kill the process" >&2
    exit 2
  fi
fi

step "provisioning isolated local D1 (state=$WRANGLER_STATE)"
MIGRATION_LOG=$(mktemp -t bc-migration.XXXXXX)
if ! wrangler d1 execute bearlychange-prod --local --persist-to "$WRANGLER_STATE" \
  --file=migrations/0001_initial.sql > "$MIGRATION_LOG" 2>&1; then
  echo "migration failed — wrangler output below:" >&2
  cat "$MIGRATION_LOG" >&2
  rm -f "$MIGRATION_LOG"
  exit 2
fi
rm -f "$MIGRATION_LOG"

step "starting wrangler dev on :$PORT"
# --var KEY:VALUE injects secrets without touching the user's .dev.vars.
wrangler dev --port "$PORT" --persist-to "$WRANGLER_STATE" --log-level error \
  --var "ADMIN_USER:$ADMIN_USER" --var "ADMIN_PASS:$ADMIN_PASS" --var "BEARLYCHANGE_TOKEN:$ADMIN_TOKEN" \
  > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# wrangler dev needs ~5s to boot (worker bundle + workerd cold start).
# Probe a route that always exists; "/" is now provided by a separate site
# repo and may not be present in the local public/ directory.
HEALTH="$BASE/api/changelog"
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$HEALTH" && break
  sleep 0.5
done
if ! curl -sf -o /dev/null "$HEALTH"; then
  echo "wrangler dev did not come up; log:" >&2
  cat "$SERVER_LOG" >&2
  exit 2
fi
echo "  (pid $SERVER_PID up)"

step "public surface (D1 seed)"
COUNT="$(curl -s "$BASE/api/changelog" | json_eval count)"
[[ "$COUNT" == "2" ]] && pass "GET /api/changelog count=2 (seeded)" || fail "GET /api/changelog count" "got '$COUNT'"
assert_http 200 "$BASE/feed.json"
assert_http 200 "$BASE/rss.xml"
assert_http 200 "$BASE/entries/launch-mvp-widget"
assert_http 404 "$BASE/entries/does-not-exist"
assert_http 200 "$BASE/widget/widget.js"

step "auth gate"
assert_http 401 "$BASE/admin/entries"
assert_http 200 -u "$ADMIN_USER:$ADMIN_PASS" "$BASE/admin/entries"

step "CLI create + list + lifecycle"
CREATE_OUT="$(echo '{"title":"CLI Created","slug":"cli-created","summary":"via cli","version":"0.2.0","type":"improvement","status":"draft"}' | ./bin/bearlychange.mjs create --from-stdin)"
if [[ "$CREATE_OUT" =~ ^created\ bc_ ]]; then pass "CLI create returned id"; else fail "CLI create output" "$CREATE_OUT"; fi

ID="$(./bin/bearlychange.mjs list --status draft --json \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d);const e=a.find(x=>x.slug==='cli-created');process.stdout.write(e?e.id:'')})")"
if [[ -n "$ID" ]]; then pass "CLI list --status draft surfaces draft ($ID)"; else fail "CLI list --status draft"; fi

./bin/bearlychange.mjs edit "$ID" --summary "edited" > /dev/null
./bin/bearlychange.mjs publish "$ID" > /dev/null
SUM="$(curl -s "$BASE/api/changelog" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);const e=o.entries.find(x=>x.id==='$ID');process.stdout.write(e?e.summary:'__missing__')})")"
[[ "$SUM" == "edited" ]] && pass "PATCH + publish reflected in /api/changelog" || fail "PATCH + publish" "got '$SUM'"

./bin/bearlychange.mjs rm "$ID" --force > /dev/null
DEL="$(curl -s "$BASE/api/changelog" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);process.stdout.write(o.entries.some(x=>x.id==='$ID')?'present':'gone')})")"
[[ "$DEL" == "gone" ]] && pass "rm removes from public list" || fail "rm" "still present"

step "validation surfaces field errors"
ERR="$(curl -s -u "$ADMIN_USER:$ADMIN_PASS" -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -X POST "$BASE/admin/entries" -d '{"title":"","slug":"BAD SLUG","summary":"x","version":"nope"}')"
for field in title slug version; do
  if [[ "$ERR" == *"\"$field\""* ]]; then pass "validation flags $field"; else fail "validation flags $field" "got: $ERR"; fi
done

./bin/bearlychange.mjs create --title "Dup" --slug dup-test --summary x --version 1.0.0 --status draft > /dev/null
DUP="$(curl -s -u "$ADMIN_USER:$ADMIN_PASS" -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -X POST "$BASE/admin/entries" -d '{"title":"D","slug":"dup-test","summary":"x","version":"1.0.0"}')"
[[ "$DUP" == *'"already in use"'* ]] && pass "duplicate slug rejected" || fail "duplicate slug" "got: $DUP"

step "bearer-token auth"
assert_http 200 -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/admin/entries"
assert_http 401 -H "Authorization: Bearer wrong-token" "$BASE/admin/entries"
assert_http 200 -u "$ADMIN_USER:$ADMIN_PASS" "$BASE/admin/entries"
CLI_TOKEN_OUT="$(BEARLYCHANGE_TOKEN="$ADMIN_TOKEN" BEARLYCHANGE_PASS="" ./bin/bearlychange.mjs list --status all --json | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d);process.stdout.write(String(a.length))})")"
[[ "$CLI_TOKEN_OUT" =~ ^[0-9]+$ ]] && pass "CLI authenticates via BEARLYCHANGE_TOKEN ($CLI_TOKEN_OUT entries)" || fail "CLI bearer" "got '$CLI_TOKEN_OUT'"
CLI_TOKEN_BAD="$(BEARLYCHANGE_TOKEN="wrong-token" BEARLYCHANGE_PASS="" ./bin/bearlychange.mjs list --status all 2>&1; echo "exit=$?")"
[[ "$CLI_TOKEN_BAD" == *"exit=4"* ]] && pass "CLI exits 4 (AUTH) on bad bearer" || fail "CLI bad bearer exit" "got: $CLI_TOKEN_BAD"

step "CSRF"
assert_http 403 -u "$ADMIN_USER:$ADMIN_PASS" -H 'Origin: https://evil.example' \
  -X POST "$BASE/admin/entries" \
  --data-urlencode 'slug=evil' --data-urlencode 'title=evil' --data-urlencode 'summary=evil' --data-urlencode 'version=1.0.0'
assert_http 302 -u "$ADMIN_USER:$ADMIN_PASS" -H "Origin: $BASE" \
  -X POST "$BASE/admin/entries" \
  --data-urlencode 'slug=same-origin' --data-urlencode 'title=so' --data-urlencode 'summary=so' --data-urlencode 'version=1.0.0' --data-urlencode 'status=draft'

step "concurrency: 20 parallel creates (D1 UNIQUE safety net)"
race_pids=()
for i in $(seq 1 20); do
  curl -s -u "$ADMIN_USER:$ADMIN_PASS" -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -X POST "$BASE/admin/entries" \
    -d "{\"title\":\"p$i\",\"slug\":\"race-$i\",\"summary\":\"x\",\"version\":\"0.0.3\",\"status\":\"draft\"}" \
    > /dev/null &
  race_pids+=($!)
done
for pid in "${race_pids[@]}"; do wait "$pid"; done
RACE="$(./bin/bearlychange.mjs list --status all --json \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d);process.stdout.write(String(a.filter(e=>e.slug.startsWith('race-')).length))})")"
[[ "$RACE" == "20" ]] && pass "20/20 parallel creates persisted" || fail "concurrency" "got $RACE/20"

step "result"
printf "  %d passed, %d failed\n" "$PASS" "$FAIL"
if (( FAIL > 0 )); then
  printf "\nfailures:\n"
  for f in "${FAILURES[@]}"; do printf "  - %s\n" "$f"; done
  exit 1
fi
