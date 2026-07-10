#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ────────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $0 [--opencode-version <version>] <workspace>

Run pre-flight checks for a demo workspace before a live pitch.

Options:
  --opencode-version <v>  OpenCode version when CLI is not in PATH.
  -h, --help              Show this help.

Example:
  $0 /tmp/flowguard-java-demo
  $0 --opencode-version 1.17.8 /tmp/flowguard-java-demo
EOF
    exit 1
}

# ─── Parse args ───────────────────────────────────────────────────────────────

OPENCODE_VERSION_OVERRIDE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --opencode-version)
            if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
                echo "Error: --opencode-version requires a version argument." >&2
                usage
            fi
            OPENCODE_VERSION_OVERRIDE="$2"
            shift 2
            ;;
        -h|--help) usage ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            ;;
        *)
            WORKSPACE="$1"
            shift
            ;;
    esac
done

if [[ -z "${WORKSPACE:-}" ]]; then
    echo "Error: <workspace> is required." >&2
    usage
fi

if [[ ! -d "$WORKSPACE" ]]; then
    echo "Error: workspace not found: $WORKSPACE" >&2
    exit 1
fi

if [[ ! -f "$WORKSPACE/pom.xml" ]]; then
    echo "Error: workspace does not appear to be a demo workspace (pom.xml missing): $WORKSPACE" >&2
    exit 1
fi

# ─── Checks ───────────────────────────────────────────────────────────────────

cd "$WORKSPACE"
PASS=0
FAIL=0

check() {
    local label="$1" result="$2"
    if [[ "$result" -eq 0 ]]; then
        echo "  PASS  $label"
        ((PASS++)) || true
    else
        echo "  FAIL  $label" >&2
        ((FAIL++)) || true
    fi
}

echo "=== FlowGuard Demo Pre-flight ==="
echo "Workspace: $WORKSPACE"
echo "Date:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# 1. Git checks
echo "--- Git ---"
COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null) && echo "  Commit: $COMMIT_HASH" || COMMIT_HASH="unknown"
check "git repository" "$(git rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo 0 || echo 1)"

# 2. Working tree clean
echo "--- Working tree ---"
if git diff --quiet 2>/dev/null; then
    check "working tree clean" 0
else
    check "working tree clean" 1
fi

# 3. Expected branches
echo "--- Branches ---"
check "branch main exists" "$(git branch --list main | wc -l | xargs test 1 -eq && echo 0 || echo 1)"
check "branch feature/add-due-date exists" "$(git branch --list feature/add-due-date | wc -l | xargs test 1 -eq && echo 0 || echo 1)"

# 4. FlowGuard installation
echo "--- FlowGuard ---"
check "opencode.json present" "$(test -f opencode.json -o -f opencode.jsonc && echo 0 || echo 1)"
check "reviewer agent present" "$(test -f .opencode/agents/flowguard-reviewer.md && echo 0 || echo 1)"
check "commands directory present" "$(test -d .opencode/commands && echo 0 || echo 1)"

# 5. Maven
echo "--- Maven ---"
check "./mvnw exists" "$(test -f mvnw && echo 0 || echo 1)"

if ./mvnw test > .demo-preflight-maven-online.log 2>&1; then
    check "Maven online test" 0
else
    echo "  (see .demo-preflight-maven-online.log for details)"
    check "Maven online test" 1
fi

echo ""
echo "--- Maven offline ---"
if ./mvnw -o test > .demo-preflight-maven-offline.log 2>&1; then
    check "Maven offline test" 0
else
    echo "  FAIL: Offline Maven failed. Do not use this workspace for the live demo." >&2
    echo "  (see .demo-preflight-maven-offline.log for details)"
    check "Maven offline test" 1
fi

# 6. Tooling versions
echo ""
echo "--- Tooling ---"

NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")
echo "  Node:     $NODE_VERSION"
check "node --version" "$(test "$NODE_VERSION" != "unknown" && echo 0 || echo 1)"

NPM_VERSION=$(npm --version 2>/dev/null || echo "unknown")
echo "  npm:      $NPM_VERSION"
check "npm --version" "$(test "$NPM_VERSION" != "unknown" && echo 0 || echo 1)"

JAVA_VERSION=$(java -version 2>&1 | head -1 || echo "unknown")
echo "  Java:     $JAVA_VERSION"
check "java -version" "$(test "$JAVA_VERSION" != "unknown" && echo 0 || echo 1)"

# OpenCode version — CLI if available, otherwise override
if opencode --version >/dev/null 2>&1; then
    OPENCODE_VERSION=$(opencode --version)
elif [[ -n "$OPENCODE_VERSION_OVERRIDE" ]]; then
    OPENCODE_VERSION="$OPENCODE_VERSION_OVERRIDE"
else
    echo "  Error: OpenCode version unknown. Provide --opencode-version or install the CLI." >&2
    OPENCODE_VERSION="unknown"
    check "OpenCode version" 1
fi

if [[ "$OPENCODE_VERSION" != "unknown" ]]; then
    echo "  OpenCode: $OPENCODE_VERSION"
    check "OpenCode version" 0
fi

# ─── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Pre-flight Summary ==="
echo ""
echo "Workspace:     $WORKSPACE"
echo "Commit:        $COMMIT_HASH"
echo "Node:          $NODE_VERSION"
echo "npm:           $NPM_VERSION"
echo "Java:          $JAVA_VERSION"
echo "OpenCode:      $OPENCODE_VERSION"
echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
    echo "Pre-flight FAILED. Fix the issues above before the live demo." >&2
    exit 1
fi

echo "Pre-flight passed. Demo workspace is ready."
