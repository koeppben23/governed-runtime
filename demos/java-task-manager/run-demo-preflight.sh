#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ────────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $0 --tarball <tgz> [--node-version-file <path>] [--opencode-version <version>] <workspace>

Run pre-flight checks for a demo workspace before a live pitch.

Options:
  --tarball <tgz>           Path to flowguard-core tarball (required).
  --node-version-file <p>   Path to .node-version file (e.g. repo root).
  --opencode-version <v>    OpenCode version when CLI is not in PATH.
  -h, --help                Show this help.

Example:
  $0 --tarball /path/to/flowguard-core-1.2.0.tgz /tmp/flowguard-java-demo
  $0 --tarball flowguard-core-*.tgz --node-version-file ~/work/governed-runtime/.node-version /tmp/flowguard-java-demo
EOF
    exit 1
}

# ─── Parse args ───────────────────────────────────────────────────────────────

TARBALL=""
NODE_VERSION_FILE=""
OPENCODE_VERSION_OVERRIDE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tarball)
            if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
                echo "Error: --tarball requires a path argument." >&2
                usage
            fi
            TARBALL="$2"
            shift 2
            ;;
        --node-version-file)
            if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
                echo "Error: --node-version-file requires a path argument." >&2
                usage
            fi
            NODE_VERSION_FILE="$2"
            shift 2
            ;;
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

if [[ -z "$TARBALL" ]]; then
    echo "Error: --tarball is required." >&2
    usage
fi

if [[ ! -f "$TARBALL" ]]; then
    echo "Error: tarball not found: $TARBALL" >&2
    exit 1
fi

if [[ ! -d "$WORKSPACE" ]]; then
    echo "Error: workspace not found: $WORKSPACE" >&2
    exit 1
fi

if [[ ! -f "$WORKSPACE/pom.xml" ]]; then
    echo "Error: workspace does not appear to be a demo workspace (pom.xml missing): $WORKSPACE" >&2
    exit 1
fi

# Resolve tarball to absolute path before cd, so relative paths survive the cd into WORKSPACE
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"

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
echo "Tarball:   $TARBALL"
echo "Date:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# 0. Tarball check
echo "--- Tarball ---"
if command -v shasum >/dev/null 2>&1; then
    TARBALL_SHA256=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
    TARBALL_SHA256=$(sha256sum "$TARBALL" | awk '{print $1}')
else
    TARBALL_SHA256="unavailable (no shasum/sha256sum)"
fi
echo "  SHA-256: $TARBALL_SHA256"
check "tarball exists and is readable" "$(test -r "$TARBALL" && echo 0 || echo 1)"

# 1. Git checks
echo "--- Git ---"
COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null) && echo "  Commit: $COMMIT_HASH" || COMMIT_HASH="unknown"
check "git repository" "$(git rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo 0 || echo 1)"

# 2. Working tree clean (including untracked files)
echo "--- Working tree ---"
if [[ -z "$(git status --porcelain)" ]]; then
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

MAVEN_VERSION=$(./mvnw --version 2>/dev/null | head -1 || echo "unknown")
echo "  Version:  $MAVEN_VERSION"
check "./mvnw --version" "$(test "$MAVEN_VERSION" != "unknown" && echo 0 || echo 1)"

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

# Validate Node version against repository .node-version (set by #619)
if [[ -n "$NODE_VERSION_FILE" ]]; then
    if [[ ! -f "$NODE_VERSION_FILE" ]]; then
        echo "  Error: --node-version-file not found: $NODE_VERSION_FILE" >&2
        check "Node version file exists" 1
    else
        EXPECTED_NODE=$(head -1 "$NODE_VERSION_FILE" | tr -d '[:space:]')
        check "Node version file readable" 0
        if [[ "$NODE_VERSION" == "v$EXPECTED_NODE" || "$NODE_VERSION" == "$EXPECTED_NODE" ]]; then
            check "Node version matches .node-version ($EXPECTED_NODE)" 0
        else
            echo "  Expected: $EXPECTED_NODE, got: $NODE_VERSION"
            check "Node version matches .node-version" 1
        fi
    fi
else
    echo "  (no --node-version-file provided — specify the repo .node-version path)"
    check "Node version file path provided" 1
fi

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
echo "Tarball SHA-256: $TARBALL_SHA256"
echo "Commit:        $COMMIT_HASH"
echo "Node:          $NODE_VERSION"
echo "npm:           $NPM_VERSION"
echo "Java:          $JAVA_VERSION"
echo "Maven:         $MAVEN_VERSION"
echo "OpenCode:      $OPENCODE_VERSION"
echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
    echo "Pre-flight FAILED. Fix the issues above before the live demo." >&2
    exit 1
fi

echo "Pre-flight passed. Demo workspace is ready."
