#!/usr/bin/env bash
# Shared FlowGuard install/verification helpers for the Java Task Manager demo
# setup scripts. This file is sourced, never executed directly, and stays
# within bash 3.2 syntax (macOS ships bash 3.2).
#
# Scope semantics mirror `flowguard install --install-scope`:
#   global -> ${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}
#   repo   -> ./.opencode relative to the prepared workspace

# Resolve the global OpenCode config root the installer writes to.
flowguard_global_config_root() {
    printf '%s\n' "${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
}

# Install FlowGuard from the bound tarball at the requested scope.
# Usage: flowguard_install <tarball> <global|repo>
flowguard_install() {
    local tarball="$1"
    local scope="$2"
    npx --package "$tarball" flowguard install \
        --install-scope "$scope" \
        --policy-mode team \
        --core-tarball "$tarball" \
        --force
}

# Use the same packed CLI's canonical V2 doctor: it verifies the native plugin,
# managed commands/mandates, config and dependencies, and rejects obsolete or
# duplicate registrations. Native discovery does not require opencode.json.
# Usage: flowguard_verify_install <tarball> <global|repo> (repo: workspace root)
flowguard_verify_install() {
    local tarball="$1"
    local scope="$2"
    local asset_root
    case "$scope" in
        global) asset_root="$(flowguard_global_config_root)" ;;
        repo) asset_root=".opencode" ;;
        *) echo "Error: invalid install scope: $scope" >&2; return 1 ;;
    esac
    local install_ok=1
    if ! npx --package "$tarball" flowguard doctor --install-scope "$scope"; then
        install_ok=0
    fi

    # Doctor treats a missing reviewer as a warning. It is mandatory for this
    # demo, so retain this stricter demo admission check for BOTH scopes.
    if [[ -s "$asset_root/agents/flowguard-reviewer.md" ]]; then
        echo "  ok: $asset_root/agents/flowguard-reviewer.md"
    else
        echo "  MISSING: $asset_root/agents/flowguard-reviewer.md" >&2
        install_ok=0
    fi

    if [[ "$install_ok" -ne 1 ]]; then
        echo "" >&2
        echo "Error: FlowGuard install verification failed. Do not start the demo." >&2
        echo "Check the 'flowguard install' output above and the tarball path." >&2
        return 1
    fi
}
