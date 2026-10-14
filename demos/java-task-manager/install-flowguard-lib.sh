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

# Fail-closed verification of the artifacts the installer writes for the
# requested scope. Exits non-zero with the missing artifacts listed.
# Usage: flowguard_verify_install <global|repo>   (repo: from the workspace root)
flowguard_verify_install() {
    local scope="$1"
    local config_dir asset_root
    if [[ "$scope" == "global" ]]; then
        config_dir="$(flowguard_global_config_root)"
        asset_root="$config_dir"
    else
        config_dir="."
        asset_root=".opencode"
    fi

    local install_ok=1
    local artifact

    if [[ -f "$config_dir/opencode.json" || -f "$config_dir/opencode.jsonc" ]]; then
        echo "  ok: $config_dir/opencode.json (or opencode.jsonc)"
    else
        echo "  MISSING: $config_dir/opencode.json (or opencode.jsonc)" >&2
        install_ok=0
    fi

    if [[ -f "$asset_root/agents/flowguard-reviewer.md" ]]; then
        echo "  ok: $asset_root/agents/flowguard-reviewer.md"
    else
        echo "  MISSING: $asset_root/agents/flowguard-reviewer.md" >&2
        install_ok=0
    fi

    if [[ -d "$asset_root/commands" ]]; then
        echo "  ok: $asset_root/commands/ ($(ls "$asset_root/commands" 2>/dev/null | wc -l | tr -d ' ') commands)"
    else
        echo "  MISSING: $asset_root/commands/ (FlowGuard slash commands)" >&2
        install_ok=0
    fi

    if [[ "$scope" == "global" ]]; then
        for artifact in "plugins/flowguard-audit.ts" "tools/flowguard.ts" "flowguard-mandates.md"; do
            if [[ -f "$asset_root/$artifact" ]]; then
                echo "  ok: $asset_root/$artifact"
            else
                echo "  MISSING: $asset_root/$artifact" >&2
                install_ok=0
            fi
        done
    fi

    if [[ "$install_ok" -ne 1 ]]; then
        echo "" >&2
        echo "Error: FlowGuard install verification failed. Do not start the demo." >&2
        echo "Check the 'flowguard install' output above and the tarball path." >&2
        exit 1
    fi
}
