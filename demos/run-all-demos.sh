#!/usr/bin/env bash
# Run every live demo sequentially with a mandatory dry-run gate.
#
# Usage: demos/run-all-demos.sh [run-root]
#   run-root defaults to a timestamped directory under /tmp.
#
# Exit codes: 0 all scenarios COMPLETE/CONTROL_PASSED; 1 any FAILED;
#             2 no FAILED but at least one NOT_VERIFIED.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
ROOT="${1:-/tmp/flowguard-demos-$RUN_ID}"
MODEL="${FLOWGUARD_DEMO_MODEL:-deepseek/deepseek-flash}"

if [[ -e "$ROOT" ]]; then
  echo "run root already exists: $ROOT" >&2
  exit 1
fi
mkdir -p "$ROOT/.tooling"

# 0. Exclusive run lease BEFORE any build: two wrappers must never mutate the
#    same checkout or build artifacts concurrently. The lease is owned by THIS
#    long-lived wrapper process (not the short-lived helper) and released by
#    identity on every exit.
LEASE_JSON="$(node "$REPO/demos/lib/run-lease.mjs" acquire --repo "$REPO" --pid $$)" || exit 1
LEASE_TOKEN="$(printf '%s' "$LEASE_JSON" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s).token))')"
LEASE_FILE="$(printf '%s' "$LEASE_JSON" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s).leaseFile))')"
echo "lease: $LEASE_FILE"
release_lease() {
  node "$REPO/demos/lib/run-lease.mjs" release --repo "$REPO" --token "$LEASE_TOKEN" >/dev/null 2>&1 || true
}
# shellcheck source=lib/signal-exit.sh
source "$REPO/demos/lib/signal-exit.sh"
install_exit_traps release_lease

# 1. Pinned npm 10: the installer engines require npm ^10 and user configs may
#    set engine-strict=true, so the ambient npm major must be satisfied.
if [[ "$(npm --version | cut -d. -f1)" != "10" ]]; then
  npm install --prefix "$ROOT/.tooling/npm10" --no-audit --no-fund npm@10 >/dev/null
  export PATH="$ROOT/.tooling/npm10/node_modules/.bin:$PATH"
fi

# 2. Run-local install lock: demo installs are repo-scoped, so independent run
#    roots do not share protected targets.
export FLOWGUARD_INSTALL_LOCK_PATH="$ROOT/.flowguard-install.lock"
export OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","provider":{"deepseek":{"models":{"deepseek-flash":{"options":{"reasoningEffort":"none","thinking":{"type":"disabled"}}}}}}}'
export FLOWGUARD_REVIEWER_EFFORT=none

RUN=(npx --yes --package=node@22.22.2 -- node)
STATUS=0
# 0 = accepted evidence, 2 = NOT_VERIFIED, any other code = FAILED. The
# mapping is unit-tested in demo-aggregate-status.test.ts.
collect() {
  STATUS="$(node "$REPO/demos/lib/aggregate-status.mjs" "$STATUS" "$1")"
}

# 3. Mandatory dry-run gate: build ONE immutable product tarball (abort on any
#    build failure), verify its bytes, canary-install exactly that artifact,
#    then hand the SAME tarball and product identity to every runner.
if ! (cd "$REPO" && npm run build >/dev/null && npm run pack:checksums >/dev/null); then
  echo "product build failed; aborting before any demo run" >&2
  exit 1
fi
VERSION="$(node -e "process.stdout.write(require('$REPO/package.json').version)")"
GATE_TARBALL="$REPO/flowguard-core-$VERSION.tgz"
GATE_SHA="$(cd "$REPO" && git rev-parse HEAD)"
if [[ ! -f "$GATE_TARBALL" ]]; then
  echo "product tarball missing after build: $GATE_TARBALL" >&2
  exit 1
fi
GATE_DIGEST="$(shasum -a 256 "$GATE_TARBALL" | awk '{print $1}')"
echo "product tarball: $GATE_TARBALL"
echo "product sha256:  $GATE_DIGEST"
echo "product gitSha:  $GATE_SHA"
"${RUN[@]}" "$REPO/demos/lib/environment-gate.mjs" --root "$ROOT/gate" --repo "$REPO" \
  --model "$MODEL" --tarball "$GATE_TARBALL" --canary-install || exit 1

run_demo() {
  local name="$1"; shift
  echo "=== demo: $name"
  # Background + wait so INT/TERM traps run promptly (bash defers traps while a
  # foreground child is running).
  "${RUN[@]}" "$@" --tarball "$GATE_TARBALL" --product-sha "$GATE_SHA" &
  local child=$!
  local code=0
  wait "$child" || code=$?
  echo "=== demo: $name exit=$code"
  collect "$code"
}

run_demo matrix "$REPO/demos/java-task-manager/run-live-matrix.mjs" --root "$ROOT/matrix" --model "$MODEL"
run_demo claim-controls "$REPO/demos/java-task-manager/run-live-claim-controls.mjs" --root "$ROOT/claims" --model "$MODEL"
run_demo risk-trigger-controls "$REPO/demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs" --root "$ROOT/risk" --model "$MODEL"
run_demo replan-recovery "$REPO/demos/risk-trigger-fixture/run-live-replan-recovery.mjs" --root "$ROOT/replan" --allow-old-plan-override

echo "=== demo: proofgraph-variants"
bash "$REPO/demos/run-proofgraph-variants.sh"
collect $?

echo "ALL DEMOS exit=$STATUS (0=accepted evidence, 2=NOT_VERIFIED, 1=FAILED)"
exit "$STATUS"
