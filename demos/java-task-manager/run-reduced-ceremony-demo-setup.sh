#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ────────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $0 [--prepare-only | --install --tarball <tgz>] <base-dir>
       $0 --verify-session <workspace>

Modes:
  --prepare-only               Copy the seed twice and write the two explicit
                               policy configs (default).
  --install --tarball <tgz>    Prepare + install FlowGuard from tarball, then
                               write the two explicit policy configs.
  --verify-session <workspace> Read-only runtime preflight: find the FlowGuard
                               session of this workspace and assert the activity
                               checks were actually selected as build + test.

The base directory receives two fresh workspaces from the same seed:
  <base-dir>/reduced-on    policy.allowReducedCeremony = true
  <base-dir>/reduced-off   policy.allowReducedCeremony = false
Both keep policy.defaultMode = team and otherwise identical configuration.

Examples:
  $0 /tmp/flowguard-reduced-demo
  $0 --install --tarball /tmp/flowguard-core-1.2.0.tgz /tmp/flowguard-reduced-demo
  $0 --verify-session /tmp/flowguard-reduced-demo/reduced-on
EOF
    exit 1
}

# ─── Parse args ───────────────────────────────────────────────────────────────

MODE="prepare-only"
TARBALL=""
VERIFY_WORKSPACE=""
BASE_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prepare-only) MODE="prepare-only"; shift ;;
        --install)      MODE="install"; shift ;;
        --tarball)
            if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
                echo "Error: --tarball requires a path argument." >&2
                usage
            fi
            TARBALL="$2"; shift 2 ;;
        --verify-session)
            if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
                echo "Error: --verify-session requires a workspace path." >&2
                usage
            fi
            VERIFY_WORKSPACE="$2"; shift 2 ;;
        -h|--help) usage ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            ;;
        *)
            BASE_DIR="$1"
            shift
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_SCRIPT="$SCRIPT_DIR/run-demo-setup.sh"

# ─── Runtime session preflight (read-only) ────────────────────────────────────

verify_session() {
    local workspace="$1"
    if [[ ! -d "$workspace" ]]; then
        echo "Error: workspace not found: $workspace" >&2
        exit 1
    fi
    node - "$workspace" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const workspace = process.argv[2];
const configRoot = process.env.OPENCODE_CONFIG_DIR || path.join(process.env.HOME, '.config', 'opencode');
const workspacesRoot = path.join(configRoot, 'workspaces');

const canonical = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

const expectedWorkspace = canonical(workspace);
const matches = [];

let fingerprints = [];
try {
  fingerprints = fs.readdirSync(workspacesRoot);
} catch {
  console.error(`FAIL  no FlowGuard workspaces under ${workspacesRoot}`);
  process.exit(1);
}

for (const fingerprint of fingerprints) {
  const sessionsRoot = path.join(workspacesRoot, fingerprint, 'sessions');
  let sessions = [];
  try {
    sessions = fs.readdirSync(sessionsRoot);
  } catch {
    continue;
  }
  for (const sessionId of sessions) {
    const statePath = path.join(sessionsRoot, sessionId, 'state', 'session-state.json');
    let state;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      continue;
    }
    const boundWorktree = state && state.binding ? state.binding.worktree : undefined;
    if (typeof boundWorktree === 'string' && canonical(boundWorktree) === expectedWorkspace) {
      matches.push({ sessionId, statePath, state, mtimeMs: fs.statSync(statePath).mtimeMs });
    }
  }
}

if (matches.length === 0) {
  console.error(`FAIL  no FlowGuard session bound to ${workspace} — run /start first`);
  process.exit(1);
}

matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
const latest = matches[0];
const checks = [...(latest.state.activeChecks ?? [])].sort();
const expectedChecks = ['build', 'test'];
const checksOk =
  checks.length === expectedChecks.length &&
  checks.every((check, index) => check === expectedChecks[index]);

// The workspace name fixes the expected frozen policy: the static pre-start
// JSON comparison cannot prove the effective policy after central/external
// overrides, so the runtime snapshot is verified explicitly.
const workspaceName = path.basename(path.resolve(workspace));
const expectedReduced =
  workspaceName === 'reduced-on' ? true : workspaceName === 'reduced-off' ? false : null;
const snapshot = latest.state.policySnapshot ?? {};
const policyOk =
  expectedReduced !== null &&
  snapshot.mode === 'team' &&
  snapshot.requireHumanGates === true &&
  snapshot.effectiveGateBehavior === 'human_gated' &&
  snapshot.allowReducedCeremony === expectedReduced;

console.log(`hostSessionId: ${latest.sessionId}`);
console.log(`activeChecks: [${checks.join(', ')}]`);
console.log(
  `policySnapshot: mode=${String(snapshot.mode)} requireHumanGates=${String(snapshot.requireHumanGates)} ` +
    `effectiveGateBehavior=${String(snapshot.effectiveGateBehavior)} ` +
    `allowReducedCeremony=${String(snapshot.allowReducedCeremony)}`,
);
if (!checksOk) {
  console.error(`FAIL  expected exactly [${expectedChecks.join(', ')}] from the seed discovery`);
  process.exit(1);
}
if (expectedReduced === null) {
  console.error(
    `FAIL  workspace basename must be 'reduced-on' or 'reduced-off' to derive the expected policy, got '${workspaceName}'`,
  );
  process.exit(1);
}
if (!policyOk) {
  console.error(
    `FAIL  expected frozen team policy with requireHumanGates=true, effectiveGateBehavior=human_gated ` +
      `and allowReducedCeremony=${String(expectedReduced)}`,
  );
  process.exit(1);
}
console.log('PASS  activeChecks selected as build + test');
console.log(`PASS  frozen team policy matches the workspace (allowReducedCeremony=${String(expectedReduced)})`);
NODE
}

if [[ -n "$VERIFY_WORKSPACE" ]]; then
    verify_session "$VERIFY_WORKSPACE"
    exit 0
fi

# ─── Validate setup arguments ─────────────────────────────────────────────────

if [[ -z "$BASE_DIR" ]]; then
    echo "Error: <base-dir> is required." >&2
    usage
fi

if [[ "$MODE" == "install" && -z "$TARBALL" ]]; then
    echo "Error: --install requires --tarball <path>." >&2
    usage
fi

if [[ "$MODE" == "install" && ! -f "$TARBALL" ]]; then
    echo "Error: tarball not found: $TARBALL" >&2
    exit 1
fi

if [[ -n "$TARBALL" ]]; then
    TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
fi

mkdir -p "$BASE_DIR"

REDUCED_ON="$BASE_DIR/reduced-on"
REDUCED_OFF="$BASE_DIR/reduced-off"

for target in "$REDUCED_ON" "$REDUCED_OFF"; do
    if [[ -e "$target" ]]; then
        echo "Error: target directory already exists: $target" >&2
        echo "Run 'rm -rf $BASE_DIR' first for a fresh comparison." >&2
        exit 1
    fi
done

# ─── Prepare both workspaces from the same seed ───────────────────────────────

echo "=== FlowGuard Reduced-Ceremony Demo Setup ==="
echo "Base:   $BASE_DIR"
echo "Seed:   $SCRIPT_DIR/seed"
echo ""

prepare_workspace() {
    local target="$1"
    if [[ "$MODE" == "install" ]]; then
        "$SETUP_SCRIPT" --install --tarball "$TARBALL" "$target"
    else
        "$SETUP_SCRIPT" --prepare-only "$target"
    fi
}

echo "--- Preparing reduced-on ---"
prepare_workspace "$REDUCED_ON"
echo ""
echo "--- Preparing reduced-off ---"
prepare_workspace "$REDUCED_OFF"

# ─── Write both policy configs explicitly ─────────────────────────────────────

write_policy_config() {
    local workspace="$1" reduced="$2"
    node - "$workspace" "$reduced" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [workspace, reduced] = process.argv.slice(2);
const file = path.join(workspace, '.opencode', 'flowguard.json');
let config = { schemaVersion: 'v1' };
if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8'));

config.schemaVersion = 'v1';
config.policy = {
  ...(config.policy ?? {}),
  defaultMode: 'team',
  allowReducedCeremony: reduced === 'true',
};

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
NODE
}

echo ""
echo "--- Writing explicit policy configs ---"
write_policy_config "$REDUCED_ON" true
write_policy_config "$REDUCED_OFF" false
echo "  ok: reduced-on  -> policy.allowReducedCeremony = true"
echo "  ok: reduced-off -> policy.allowReducedCeremony = false"

# ─── Parity checks (fail closed) ──────────────────────────────────────────────

echo ""
echo "--- Verifying identical starting state ---"

TREE_ON="$(git -C "$REDUCED_ON" rev-parse 'HEAD^{tree}')"
TREE_OFF="$(git -C "$REDUCED_OFF" rev-parse 'HEAD^{tree}')"
if [[ "$TREE_ON" != "$TREE_OFF" ]]; then
    echo "Error: workspaces differ in their committed seed (tree $TREE_ON vs $TREE_OFF)." >&2
    exit 1
fi
echo "  ok: identical seed tree ($TREE_ON)"

node - "$REDUCED_ON" "$REDUCED_OFF" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [onDir, offDir] = process.argv.slice(2);
const fail = (message) => {
  console.error(`Error: ${message}`);
  process.exit(1);
};
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

// The seed must expose exactly the two discovery scripts the demo relies on.
for (const dir of [onDir, offDir]) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};
  if (scripts.build !== './mvnw verify' || scripts.test !== './mvnw test') {
    fail(`${dir}/package.json does not expose build=./mvnw verify and test=./mvnw test`);
  }
  if (!fs.existsSync(path.join(dir, 'TICKET_DOCS.md'))) {
    fail(`${dir}/TICKET_DOCS.md is missing from the seed`);
  }
}

const readConfig = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, '.opencode', 'flowguard.json'), 'utf8'));
const on = readConfig(onDir);
const off = readConfig(offDir);

if (on.schemaVersion !== 'v1' || off.schemaVersion !== 'v1') {
  fail('both flowguard.json files must declare schemaVersion v1');
}
if (on.policy?.defaultMode !== 'team' || off.policy?.defaultMode !== 'team') {
  fail('both flowguard.json files must freeze policy.defaultMode team');
}
if (on.policy?.allowReducedCeremony !== true) {
  fail('reduced-on must set policy.allowReducedCeremony true');
}
if (off.policy?.allowReducedCeremony !== false) {
  fail('reduced-off must set policy.allowReducedCeremony false');
}

const strip = (config) => {
  const policy = { ...config.policy };
  delete policy.allowReducedCeremony;
  return { ...config, policy };
};
if (canonical(strip(on)) !== canonical(strip(off))) {
  fail('the two workspaces differ beyond policy.allowReducedCeremony');
}
console.log('  ok: identical team config, identical discovery scripts, identical seed ticket');
console.log('  ok: difference is exactly policy.allowReducedCeremony (true vs false)');
NODE

# ─── Done ─────────────────────────────────────────────────────────────────────

cat <<EOF

=== Setup complete ===

Next steps:
  1. Open $REDUCED_ON in OpenCode Desktop and follow REDUCED_CEREMONY.md (scenario B).
  2. After /start, verify the runtime selection before narrating "2/2":
       $0 --verify-session $REDUCED_ON
  3. Open $REDUCED_OFF in OpenCode Desktop and follow REDUCED_CEREMONY.md (scenario C).
       $0 --verify-session $REDUCED_OFF
EOF
