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
collect() {
  local code="$1"
  if [[ "$code" -eq 1 ]]; then STATUS=1; elif [[ "$code" -eq 2 && "$STATUS" -eq 0 ]]; then STATUS=2; fi
}

# 3. Mandatory dry-run gate (npm canary install + provider ping).
"${RUN[@]}" "$REPO/demos/lib/environment-gate.mjs" --root "$ROOT/gate" --repo "$REPO" \
  --model "$MODEL" --canary-install || exit 1

run_demo() {
  local name="$1"; shift
  echo "=== demo: $name"
  "${RUN[@]}" "$@" ; local code=$?
  echo "=== demo: $name exit=$code"
  collect "$code"
}

run_demo matrix "$REPO/demos/java-task-manager/run-live-matrix.mjs" --root "$ROOT/matrix" --model "$MODEL"
run_demo claim-controls "$REPO/demos/java-task-manager/run-live-claim-controls.mjs" --root "$ROOT/claims" --model "$MODEL"
run_demo risk-trigger-controls "$REPO/demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs" --root "$ROOT/risk" --model "$MODEL"
run_demo replan-recovery "$REPO/demos/risk-trigger-fixture/run-live-replan-recovery.mjs" --root "$ROOT/replan" --allow-old-plan-override

echo "=== demo: proofgraph-variants"
bash "$REPO/demos/run-proofgraph-variants.sh" || collect 1

echo "ALL DEMOS exit=$STATUS (0=accepted evidence, 2=NOT_VERIFIED, 1=FAILED)"
exit "$STATUS"
