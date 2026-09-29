#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [--prepare-only | --install --tarball <tgz>] [--demo main|reduced] <target-root>

Prepare fresh FlowGuard live-demo workspaces. Without --demo, prepares all
installable live demos.

Modes:
  --prepare-only               Copy seeds and initialize Git repositories (default).
  --install --tarball <tgz>    Prepare and install FlowGuard from tarball.

Demos:
  --demo main                  Java Task Manager: architecture, development, peer review.
  --demo reduced               Reduced-ceremony A/B comparison.

The target root must not already exist. The produced layout is:
  <target-root>/java-task-manager
  <target-root>/reduced-ceremony/reduced-on
  <target-root>/reduced-ceremony/reduced-off

Examples:
  $0 --prepare-only /tmp/flowguard-demos
  $0 --install --tarball ./flowguard-core-1.2.0.tgz /tmp/flowguard-demos
  $0 --install --tarball ./flowguard-core-1.2.0.tgz --demo main /tmp/flowguard-demos
EOF
    exit 1
}

MODE="prepare-only"
MODE_EXPLICIT=""
TARBALL=""
DEMO="all"
TARGET_ROOT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prepare-only)
            if [[ -n "$MODE_EXPLICIT" ]]; then
                echo "Error: --prepare-only and --install are mutually exclusive." >&2
                usage
            fi
            MODE="prepare-only"; MODE_EXPLICIT="prepare-only"; shift ;;
        --install)
            if [[ -n "$MODE_EXPLICIT" ]]; then
                echo "Error: --prepare-only and --install are mutually exclusive." >&2
                usage
            fi
            MODE="install"; MODE_EXPLICIT="install"; shift ;;
        --tarball)
            if [[ $# -lt 2 || "$2" == -* || -z "$2" ]]; then
                echo "Error: --tarball requires a path argument." >&2
                usage
            fi
            TARBALL="$2"; shift 2 ;;
        --demo)
            if [[ $# -lt 2 || "$2" == -* || ( "$2" != "main" && "$2" != "reduced" ) ]]; then
                echo "Error: --demo requires 'main' or 'reduced'." >&2
                usage
            fi
            if [[ "$DEMO" != "all" ]]; then
                echo "Error: --demo may be specified only once." >&2
                usage
            fi
            DEMO="$2"; shift 2 ;;
        -h|--help) usage ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            ;;
        *)
            if [[ -n "$TARGET_ROOT" ]]; then
                echo "Error: only one <target-root> may be specified." >&2
                usage
            fi
            TARGET_ROOT="$1"; shift
            ;;
    esac
done

if [[ -z "$TARGET_ROOT" ]]; then
    echo "Error: <target-root> is required." >&2
    usage
fi

if [[ "$MODE" == "install" && -z "$TARBALL" ]]; then
    echo "Error: --install requires --tarball <path>." >&2
    usage
fi

if [[ "$MODE" != "install" && -n "$TARBALL" ]]; then
    echo "Error: --tarball may be used only with --install." >&2
    usage
fi

if [[ -e "$TARGET_ROOT" ]]; then
    echo "Error: target root already exists: $TARGET_ROOT" >&2
    echo "Choose a new target root or remove it before preparing a fresh demo environment." >&2
    exit 1
fi

TARGET_PARENT="$(dirname "$TARGET_ROOT")"
if [[ ! -d "$TARGET_PARENT" ]]; then
    echo "Error: target root parent directory does not exist: $TARGET_PARENT" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAIN_SETUP="$SCRIPT_DIR/demos/java-task-manager/run-demo-setup.sh"
REDUCED_SETUP="$SCRIPT_DIR/demos/java-task-manager/run-reduced-ceremony-demo-setup.sh"

for script in "$MAIN_SETUP" "$REDUCED_SETUP"; do
    if [[ ! -f "$script" ]]; then
        echo "Error: demo setup script not found: $script" >&2
        exit 1
    fi
done

if [[ "$MODE" == "install" && ! -f "$TARBALL" ]]; then
    echo "Error: tarball not found: $TARBALL" >&2
    exit 1
fi

if [[ "$MODE" == "install" ]]; then
    TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
fi

MAIN_TARGET="$TARGET_ROOT/java-task-manager"
REDUCED_TARGET="$TARGET_ROOT/reduced-ceremony"

mkdir "$TARGET_ROOT"

run_setup() {
    local script="$1" target="$2"
    if [[ "$MODE" == "install" ]]; then
        "$script" --install --tarball "$TARBALL" "$target"
    else
        "$script" --prepare-only "$target"
    fi
}

echo "=== FlowGuard Demo Setup ==="
echo "Target root: $TARGET_ROOT"
echo "Demos: $DEMO"

if [[ "$DEMO" == "all" || "$DEMO" == "main" ]]; then
    echo ""
    echo "--- Preparing Java Task Manager ---"
    run_setup "$MAIN_SETUP" "$MAIN_TARGET"
fi

if [[ "$DEMO" == "all" || "$DEMO" == "reduced" ]]; then
    echo ""
    echo "--- Preparing Reduced-Ceremony A/B ---"
    run_setup "$REDUCED_SETUP" "$REDUCED_TARGET"
fi

verify_workspace() {
    local workspace="$1"
    if [[ ! -d "$workspace" ]]; then
        echo "Error: expected demo workspace was not created: $workspace" >&2
        exit 1
    fi
}

if [[ "$DEMO" == "all" || "$DEMO" == "main" ]]; then
    verify_workspace "$MAIN_TARGET"
fi
if [[ "$DEMO" == "all" || "$DEMO" == "reduced" ]]; then
    verify_workspace "$REDUCED_TARGET/reduced-on"
    verify_workspace "$REDUCED_TARGET/reduced-off"
fi

echo ""
echo "=== FlowGuard demos ready ==="
echo ""
if [[ "$DEMO" == "all" || "$DEMO" == "main" ]]; then
    echo "Main demo:"
    echo "  $MAIN_TARGET"
    echo "  Flows: architecture, development, peer-review"
    echo ""
fi
if [[ "$DEMO" == "all" || "$DEMO" == "reduced" ]]; then
    echo "Reduced Ceremony A/B:"
    echo "  $REDUCED_TARGET/reduced-on"
    echo "  $REDUCED_TARGET/reduced-off"
    echo ""
fi
echo "Executable ProofGraph fixtures:"
echo "  ./demos/run-proofgraph-variants.sh"
