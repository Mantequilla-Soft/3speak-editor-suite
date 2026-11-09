#!/usr/bin/env bash
# Sandbox test of editor-deploy: a throwaway git "remote" + checkout, and stand-in docker /
# curl / sleep commands that record what the script does and fail on demand. Nothing real
# is touched.   bash tests/run.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok   $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL $1"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; echo "       ($2)"; tail -5 "$T/deploy.log" | sed 's/^/       log: /'; fi; }

# ── stand-ins ──────────────────────────────────────────────────────────────────────
mkdir -p "$T/stub" "$T/flags"
cat > "$T/stub/docker" <<'EOF'
#!/usr/bin/env bash
F="$FLAGS"; echo "docker $*" >> "$F/docker.log"
case "$1 $2" in
  "image inspect") exit 0 ;;
  "image tag") [[ "$4" == *backend:latest && "$3" == *:rollback ]] && rm -f "$F/backend_live_new"; exit 0 ;;
  "inspect -f") echo "2026-01-01T00:00:00Z"; exit 0 ;;
esac
if [ "$1" = compose ]; then
  shift
  case "$1" in
    ps) echo "cid-$3"; exit 0 ;;
    build) svc="${@: -1}"; [ -e "$F/build_fail_$svc" ] && exit 1; exit 0 ;;
    up) svc="${@: -1}"; [ "$svc" = backend ] && [ ! -e "$F/rolling" ] && touch "$F/backend_live_new"; exit 0 ;;
  esac
fi
exit 0
EOF
cat > "$T/stub/curl" <<'EOF'
#!/usr/bin/env bash
F="$FLAGS"; url="${@: -1}"; code=0; body=""
for a in "$@"; do [ "$a" = '%{http_code}' ] && code=1; done
case "$url" in
  */api/health)
    if [ -e "$F/backend_live_new" ] && [ -e "$F/new_backend_bad" ]; then body='{"status":"broken"}'
    elif [ -e "$F/busy" ]; then body='{"status":"ok","activeJobs":1}'
    else body='{"status":"ok","activeJobs":0}'; fi; c=200 ;;
  */api/upload|*/api/render) c=401; body="no" ;;
  */health) c=200; body=ok ;;
  */assets/index-abc.js) c=200; body="bundle"; [ -e "$F/bundle_bad" ] && body="https://deveditor.okinoko.io" ;;
  */) c=200; body='<script src="/assets/index-abc.js"></script>' ;;
  *) c=404 ;;
esac
if [ $code = 1 ]; then printf '%s' "$c"; else printf '%s' "$body"; fi
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/stub/sleep"
chmod 755 "$T/stub/"*
export FLAGS="$T/flags"

# ── the script under test: own paths, stand-ins first on PATH, no waiting ───────────
sed -e "s|^CONF=.*|CONF=$T/conf|" -e "s|^STATE_DIR=.*|STATE_DIR=$T/state|" -e "s|^LOG=.*|LOG=$T/deploy.log|" \
    -e "s|^LOCK=.*|LOCK=$T/lock|" -e "s|^SYS_PATH=.*|SYS_PATH=$T/stub:/usr/local/bin:/usr/bin:/bin|" \
    -e "s|^IDLE_WAIT_SECONDS=.*|IDLE_WAIT_SECONDS=0|" -e "s|^BOOT_WAIT_SECONDS=.*|BOOT_WAIT_SECONDS=0|" \
    "$HERE/editor-deploy" > "$T/editor-deploy"
chmod 755 "$T/editor-deploy"

# ── a remote with main, a checkout carrying its own docker-compose.yml ─────────────
git init -q --bare "$T/remote.git"
git clone -q "$T/remote.git" "$T/seed" 2>/dev/null
cd "$T/seed"; git config user.email t@t; git config user.name t
mkdir -p backend gateway src; echo a > backend/a.js; echo g > gateway/g.js; echo s > src/s.js
echo "dev: compose" > docker-compose.yml; echo readme > README.md
git add -A; git commit -qm c0; git branch -M main; git push -q origin main
git clone -q -b main "$T/remote.git" "$T/checkout" 2>/dev/null
cd "$T/checkout"; git config user.email t@t; git config user.name t
git remote rename origin suite
echo "PROD: compose" > docker-compose.yml
cat > "$T/conf" <<EOF
NAME=a
REPO=$T/checkout
REMOTE=suite
SERVICES="gateway backend frontend"
BACKEND_URL=http://127.0.0.1:3102
FRONTEND_URL=http://127.0.0.1:8089
GATEWAY_URL=http://127.0.0.1:3200
ALLOWED_LOCAL="docker-compose.yml"
FORBID_IN_BUNDLE="deveditor localhost:"
PROJECT=ed
EOF
commit() { (cd "$T/seed" && for f in "$@"; do echo "$RANDOM" >> "$f"; done && git add -A && git commit -qm "change $*" && git push -q origin main && git rev-parse HEAD); }
head_is() { [ "$(git -C "$T/checkout" rev-parse HEAD)" = "$1" ]; }
run() { : > "$FLAGS/docker.log"; "$T/editor-deploy" "$@" >/dev/null 2>&1; echo $?; }
dlog() { cat "$FLAGS/docker.log"; }

echo "editor-deploy sandbox"
c0=$(git -C "$T/checkout" rev-parse HEAD)
expect "already deployed: no-op, exit 0" '[ "$(run deploy $c0)" = 0 ] && [ ! -s "$FLAGS/docker.log" ]'

c1=$(commit backend/a.js)
expect "check changes nothing" '[ "$(run check $c1)" = 0 ] && head_is $c0 && [ ! -s "$FLAGS/docker.log" ]'
expect "backend change: deploys, rebuilds the backend only" '[ "$(run deploy $c1)" = 0 ] && head_is $c1 && dlog | grep -q "compose build -q backend" && ! dlog | grep -q "build -q frontend" && ! dlog | grep -q "build -q gateway"'
expect "the previous backend image is kept as :rollback" 'dlog | grep -q "image tag ed-backend:latest ed-backend:rollback"'
expect "the box's own docker-compose.yml survives" 'grep -q PROD "$T/checkout/docker-compose.yml"'

c2=$(mkdir -p "$T/seed/deploy" "$T/seed/.github" && commit README.md deploy/setup.sh .github/deploy.yml)
expect "docs, deploy/ and .github only: fast-forward, nothing rebuilt" '[ "$(run deploy $c2)" = 0 ] && head_is $c2 && ! dlog | grep -q "compose build"'

c3=$(commit src/s.js gateway/g.js)
expect "frontend + gateway: both rebuilt, gateway swapped before frontend" '[ "$(run deploy $c3)" = 0 ] && head_is $c3 && [ "$(dlog | grep -oE "up -d --no-deps --no-build [a-z]+" | awk "{print \$NF}" | tr "\n" " ")" = "gateway frontend " ]'

c4=$(commit backend/a.js)
touch "$FLAGS/build_fail_backend"
expect "build fails: rolled back, nothing swapped" '[ "$(run deploy $c4)" = 1 ] && head_is $c3 && ! dlog | grep -q "up -d" && dlog | grep -q "image tag ed-backend:rollback ed-backend:latest"'
rm -f "$FLAGS/build_fail_backend"

touch "$FLAGS/new_backend_bad"
expect "new backend unhealthy: rolled back to the old image and restarted" '[ "$(run deploy $c4)" = 1 ] && head_is $c3 && dlog | grep -q "image tag ed-backend:rollback ed-backend:latest" && [ "$(dlog | grep -c "up -d --no-deps --no-build backend")" = 2 ]'
rm -f "$FLAGS/new_backend_bad" "$FLAGS/backend_live_new"

touch "$FLAGS/busy"
expect "backend busy rendering: never swapped, rolled back" '[ "$(run deploy $c4)" = 1 ] && head_is $c3 && ! dlog | grep -q "up -d"'
rm -f "$FLAGS/busy"

expect "then idle: deploys" '[ "$(run deploy $c4)" = 0 ] && head_is $c4'
rm -f "$FLAGS/backend_live_new"

c5=$(commit src/s.js)
touch "$FLAGS/bundle_bad"
expect "frontend built with dev URLs: rolled back" '[ "$(run deploy $c5)" = 1 ] && head_is $c4 && dlog | grep -q "image tag ed-frontend:rollback ed-frontend:latest"'
rm -f "$FLAGS/bundle_bad"

c6=$(commit docker-compose.yml)
expect "upstream changed the box's own docker-compose.yml: refused" '[ "$(run deploy $c6)" = 1 ] && head_is $c4 && grep -q "merge it by hand" "$T/deploy.log"'

git -C "$T/checkout" checkout -q "$c4" -- . 2>/dev/null; echo "PROD: compose" > "$T/checkout/docker-compose.yml"
echo hack >> "$T/checkout/src/s.js"
expect "a local edit to another tracked file: refused" '[ "$(run deploy $c5)" = 1 ] && grep -q "local edit to tracked file src/s.js" "$T/deploy.log"'
git -C "$T/checkout" checkout -q -- src/s.js

expect "a commit not on main: refused" '[ "$(run deploy 0123456789abcdef0123456789abcdef01234567)" = 1 ]'
expect "never backwards: an older main commit is a no-op" '[ "$(run deploy $c1)" = 0 ] && head_is $c4'
expect "malformed argument: refused before anything runs" '[ "$(run deploy HEAD)" = 2 ]'

# the forced command
expect "entry refuses anything but deploy|check <sha>" '! SSH_ORIGINAL_COMMAND="id" bash "$HERE/editor-deploy-entry" 2>/dev/null && ! SSH_ORIGINAL_COMMAND="deploy $c1; id" bash "$HERE/editor-deploy-entry" 2>/dev/null'

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
