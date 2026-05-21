#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FlowGuard Codex Cloud Setup Script
# ─────────────────────────────────────────────────────────────────────────────
#
# Installs FlowGuard governance runtime in a Codex cloud sandbox container.
# Designed to run as part of the Codex environment setup before task execution.
#
# Usage:
#   curl -sSf <release-url>/codex-cloud-setup.sh | bash
#   OR
#   bash scripts/codex-cloud-setup.sh
#
# Environment variables:
#   FLOWGUARD_VERSION  - Version to install (default: latest)
#   FLOWGUARD_DIR      - Installation directory (default: /usr/local/lib/flowguard)
#   FLOWGUARD_BIN      - Binary symlink location (default: /usr/local/bin)
#
# Requirements:
#   - Node.js >= 20.x (pre-installed in Codex cloud containers)
#   - Write access to FLOWGUARD_DIR and FLOWGUARD_BIN
#
# @see https://github.com/koeppben23/governed-runtime/issues/251 (Gap 6)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

FLOWGUARD_VERSION="${FLOWGUARD_VERSION:-latest}"
FLOWGUARD_DIR="${FLOWGUARD_DIR:-/usr/local/lib/flowguard}"
FLOWGUARD_BIN="${FLOWGUARD_BIN:-/usr/local/bin}"
REPO="koeppben23/governed-runtime"

# ─── Helpers ──────────────────────────────────────────────────────────────────

info() { echo "[FlowGuard Setup] $*"; }
error() { echo "[FlowGuard Setup] ERROR: $*" >&2; exit 1; }

check_prereqs() {
  command -v node >/dev/null 2>&1 || error "Node.js not found. Codex cloud requires Node.js >= 20."
  local node_version
  node_version=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [ "$node_version" -lt 20 ]; then
    error "Node.js >= 20 required (found: v${node_version})"
  fi
  info "Node.js $(node --version) detected"
}

# ─── Installation ─────────────────────────────────────────────────────────────

install_flowguard() {
  info "Installing FlowGuard ${FLOWGUARD_VERSION} to ${FLOWGUARD_DIR}..."

  # Create installation directory.
  mkdir -p "${FLOWGUARD_DIR}"

  # Install from npm (works in air-gapped if pre-seeded, otherwise fetches).
  if [ "$FLOWGUARD_VERSION" = "latest" ]; then
    npm install --prefix "${FLOWGUARD_DIR}" --global-style --no-save flowguard 2>/dev/null \
      || npm install --prefix "${FLOWGUARD_DIR}" --global-style --no-save "@koeppben23/flowguard" 2>/dev/null \
      || install_from_tarball
  else
    npm install --prefix "${FLOWGUARD_DIR}" --global-style --no-save "flowguard@${FLOWGUARD_VERSION}" 2>/dev/null \
      || npm install --prefix "${FLOWGUARD_DIR}" --global-style --no-save "@koeppben23/flowguard@${FLOWGUARD_VERSION}" 2>/dev/null \
      || install_from_tarball
  fi

  info "FlowGuard installed to ${FLOWGUARD_DIR}"
}

install_from_tarball() {
  info "npm install failed — attempting tarball install from GitHub releases..."
  local tarball_url
  if [ "$FLOWGUARD_VERSION" = "latest" ]; then
    tarball_url="https://github.com/${REPO}/releases/latest/download/flowguard.tgz"
  else
    tarball_url="https://github.com/${REPO}/releases/download/v${FLOWGUARD_VERSION}/flowguard.tgz"
  fi

  local tmp_tarball="/tmp/flowguard-install.tgz"
  curl -sSfL "$tarball_url" -o "$tmp_tarball" || error "Failed to download tarball from ${tarball_url}"
  npm install --prefix "${FLOWGUARD_DIR}" --global-style --no-save "$tmp_tarball"
  rm -f "$tmp_tarball"
}

# ─── Symlinks ─────────────────────────────────────────────────────────────────

create_symlinks() {
  info "Creating binary symlinks in ${FLOWGUARD_BIN}..."
  mkdir -p "${FLOWGUARD_BIN}"

  local pkg_bin="${FLOWGUARD_DIR}/node_modules/.bin"
  if [ -d "$pkg_bin" ]; then
    for bin_file in "$pkg_bin"/flowguard*; do
      [ -e "$bin_file" ] || continue
      local name
      name=$(basename "$bin_file")
      ln -sf "$bin_file" "${FLOWGUARD_BIN}/${name}"
      info "  ${FLOWGUARD_BIN}/${name} -> ${bin_file}"
    done
  fi
}

# ─── MCP Configuration ────────────────────────────────────────────────────────

configure_mcp() {
  info "Configuring MCP server for Codex..."

  # Codex reads .codex/mcp.json from the workspace root.
  local workspace="${PWD}"
  local mcp_dir="${workspace}/.codex"
  local mcp_config="${mcp_dir}/mcp.json"

  mkdir -p "$mcp_dir"

  # Only write if not already configured.
  if [ -f "$mcp_config" ] && grep -q "flowguard" "$mcp_config" 2>/dev/null; then
    info "MCP config already contains FlowGuard — skipping"
    return
  fi

  cat > "$mcp_config" <<'MCPEOF'
{
  "mcpServers": {
    "flowguard": {
      "command": "flowguard-mcp",
      "args": [],
      "env": {}
    }
  }
}
MCPEOF

  info "MCP config written to ${mcp_config}"
}

# ─── Verification ─────────────────────────────────────────────────────────────

verify_installation() {
  info "Verifying installation..."

  if command -v flowguard-mcp >/dev/null 2>&1; then
    info "flowguard-mcp binary: OK"
  elif [ -x "${FLOWGUARD_BIN}/flowguard-mcp" ]; then
    info "flowguard-mcp binary: OK (at ${FLOWGUARD_BIN}/flowguard-mcp)"
  else
    error "flowguard-mcp binary not found after installation"
  fi

  info "Installation verified successfully"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  info "=== FlowGuard Codex Cloud Setup ==="
  info "Version: ${FLOWGUARD_VERSION}"
  info "Directory: ${FLOWGUARD_DIR}"
  info ""

  check_prereqs
  install_flowguard
  create_symlinks
  configure_mcp
  verify_installation

  info ""
  info "=== Setup complete ==="
  info "FlowGuard governance is ready for Codex cloud tasks."
}

main "$@"
