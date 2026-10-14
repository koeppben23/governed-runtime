#!/usr/bin/env bash
set -euo pipefail

# ─── Usage ────────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $0 [--prepare-only | --install --tarball <tgz> [--install-scope global|repo]] <target-dir>

Modes:
  --prepare-only               Copy seed, git init, commit (default).
  --install --tarball <tgz>    Prepare + install FlowGuard from tarball.

Install scope (with --install):
  global                       Install into ~/.config/opencode (default): commands,
                               plugin, and mandates for every OpenCode project.
  repo                         Install into <target-dir>/.opencode: isolated to
                               this workspace.

Examples:
  $0 /tmp/flowguard-java-demo
  $0 --install --tarball /tmp/flowguard-core-2.0.0-tp.2.tgz /tmp/flowguard-java-demo
  $0 --install --install-scope repo --tarball /tmp/flowguard-core-2.0.0-tp.2.tgz /tmp/flowguard-java-demo
EOF
    exit 1
}

# ─── Parse args ───────────────────────────────────────────────────────────────

MODE="prepare-only"
TARBALL=""
INSTALL_SCOPE="global"
INSTALL_SCOPE_EXPLICIT=""

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
        --install-scope)
            if [[ $# -lt 2 || "$2" == -* || ( "$2" != "global" && "$2" != "repo" ) ]]; then
                echo "Error: --install-scope requires 'global' or 'repo'." >&2
                usage
            fi
            INSTALL_SCOPE="$2"; INSTALL_SCOPE_EXPLICIT="1"; shift 2 ;;
        -h|--help)      usage ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            ;;
        *)
            TARGET_DIR="$1"
            shift
            ;;
    esac
done

if [[ -z "${TARGET_DIR:-}" ]]; then
    echo "Error: <target-dir> is required." >&2
    usage
fi

if [[ "$MODE" == "install" && -z "$TARBALL" ]]; then
    echo "Error: --install requires --tarball <path>." >&2
    usage
fi

if [[ "$MODE" != "install" && -n "$INSTALL_SCOPE_EXPLICIT" ]]; then
    echo "Error: --install-scope may be used only with --install." >&2
    usage
fi

# ─── Locate seed ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_DIR="$SCRIPT_DIR/seed"
LIB_SCRIPT="$SCRIPT_DIR/install-flowguard-lib.sh"

if [[ ! -d "$SEED_DIR" ]]; then
    echo "Error: seed directory not found at $SEED_DIR" >&2
    exit 1
fi

if [[ ! -f "$LIB_SCRIPT" ]]; then
    echo "Error: install helper not found at $LIB_SCRIPT" >&2
    exit 1
fi

# shellcheck source=install-flowguard-lib.sh
source "$LIB_SCRIPT"

if [[ "$MODE" == "install" && ! -f "$TARBALL" ]]; then
    echo "Error: tarball not found: $TARBALL" >&2
    exit 1
fi

# Resolve tarball to absolute path before cd, so relative paths survive the cd into TARGET_DIR
if [[ "$MODE" == "install" ]]; then
    TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
fi

# ─── Prepare ──────────────────────────────────────────────────────────────────

echo "=== FlowGuard Demo Setup ==="
echo "Source: $SEED_DIR"
echo "Target: $TARGET_DIR"

if [[ -d "$TARGET_DIR" ]]; then
    echo "Error: target directory already exists: $TARGET_DIR" >&2
    echo "Run 'rm -rf $TARGET_DIR' first, or see RESET.md." >&2
    exit 1
fi

echo ""
echo "--- Copying seed ---"
cp -R "$SEED_DIR" "$TARGET_DIR"

echo "--- Initializing git repository ---"
cd "$TARGET_DIR"
git init --initial-branch main
git config user.email "demo@flowguard"
git config user.name "FlowGuard Demo"
git add -A
git commit -m "Initial: Java Task Manager with known bug"

echo ""
echo "--- Creating demo review branch ---"
git checkout -b feature/add-due-date
cp "$SCRIPT_DIR/review-fixtures/Task.java" \
   "$TARGET_DIR/src/main/java/com/example/taskmanager/model/Task.java"
cp "$SCRIPT_DIR/review-fixtures/CreateTaskRequest.java" \
   "$TARGET_DIR/src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java"
git add -A
git commit -m "Add dueDate field"
git checkout main

echo ""
echo "--- Git status ---"
git status --short
# Expected: no output (clean working tree)

# ─── Install FlowGuard (optional) ─────────────────────────────────────────────

if [[ "$MODE" == "install" ]]; then
    echo ""
    echo "--- Installing FlowGuard (install scope: $INSTALL_SCOPE) ---"
    if [[ "$INSTALL_SCOPE" == "global" ]]; then
        echo "  Note: a global install writes to ~/.config/opencode and activates FlowGuard"
        echo "        for every OpenCode project. The global policy default becomes 'team';"
        echo "        a repository config can only restrict it."
        echo "        Restart OpenCode Desktop after the install to load commands and plugin."
    fi
    flowguard_install "$TARBALL" "$INSTALL_SCOPE"

    echo ""
    echo "--- Verifying FlowGuard install ---"
    # Fail closed: the demo must not proceed to `opencode serve` on a broken
    # install. Assert the scope-specific artifacts the OpenCode installer writes.
    flowguard_verify_install "$INSTALL_SCOPE"
    echo "--- FlowGuard install verified ---"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "=== Demo workspace prepared ==="
echo ""
echo "--- Prepared branches ---"
git branch --list
echo ""
echo "--- Branch history ---"
git log --oneline --decorate --all --graph
echo ""
echo "Next steps:"
echo "  cd $TARGET_DIR"
echo "  ./mvnw test           # Verify: 16 tests, 0 failures, 1 skipped"
if [[ "$MODE" == "prepare-only" ]]; then
    echo "  # Install FlowGuard globally (default) and restart OpenCode Desktop:"
    echo "  npx --package <tarball> flowguard install --policy-mode team --core-tarball <tarball> --force"
    echo "  # Or install repo-scoped into this workspace only:"
    echo "  npx --package <tarball> flowguard install --install-scope repo --policy-mode team --core-tarball <tarball> --force"
fi
echo "  # Open $TARGET_DIR in OpenCode Desktop"
if [[ "$MODE" == "install" && "$INSTALL_SCOPE" == "global" ]]; then
    echo "  # (Restart OpenCode Desktop first so the global FlowGuard install is loaded.)"
fi
echo "  # Then follow DEMO_SCRIPT.md"
echo "  # No FlowGuard session has been started and no demo flow has run."
