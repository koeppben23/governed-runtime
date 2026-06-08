#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FlowGuard Codex Cloud Setup Script
# ─────────────────────────────────────────────────────────────────────────────
#
# Installs FlowGuard governance runtime in a Codex cloud sandbox container.
# Designed to run as part of the Codex environment setup before task execution.
#
# Distribution model: FlowGuard is NOT published to the npm registry. The only
# supported install source is a versioned GitHub Release tarball named
# `flowguard-core-<version>.tgz`. See docs/distribution-model.md.
#
# Usage:
#   bash scripts/codex-cloud-setup.sh
#
# Environment variables:
#   FLOWGUARD_VERSION    Release tag to install (e.g. "1.2.0-rc.3"). Required
#                        unless FLOWGUARD_TARBALL is set. No "latest" channel
#                        is supported, since releases are versioned tarballs.
#   FLOWGUARD_TARBALL    Optional path or URL to a pre-staged tarball. Skips
#                        the GitHub Release download path entirely.
#   FLOWGUARD_REPO       GitHub repo (default: koeppben23/governed-runtime)
#   FLOWGUARD_DIR        Installation directory for the package
#                        (default: /usr/local/lib/flowguard)
#   FLOWGUARD_BIN        Binary symlink location (default: /usr/local/bin)
#   FLOWGUARD_SKIP_INSTALL_HOST=1
#                        Skip the post-extract `flowguard install` host wiring.
#                        Use this when only the MCP server binary is needed
#                        and the host config is mounted from outside.
#
# Requirements:
#   - Node.js >= 20.x (pre-installed in Codex cloud containers)
#   - curl
#   - Write access to FLOWGUARD_DIR and FLOWGUARD_BIN
#
# Verification status: NOT_VERIFIED in a live Codex Cloud sandbox. The script
# follows the documented install contract (see docs/distribution-model.md and
# docs/multi-platform-deployment.md) but has not been end-to-end exercised in
# Codex Cloud since the rewrite. Report issues against:
#   https://github.com/koeppben23/governed-runtime/issues
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

FLOWGUARD_VERSION="${FLOWGUARD_VERSION:-}"
FLOWGUARD_TARBALL="${FLOWGUARD_TARBALL:-}"
FLOWGUARD_REPO="${FLOWGUARD_REPO:-koeppben23/governed-runtime}"
FLOWGUARD_DIR="${FLOWGUARD_DIR:-/usr/local/lib/flowguard}"
FLOWGUARD_BIN="${FLOWGUARD_BIN:-/usr/local/bin}"
FLOWGUARD_SKIP_INSTALL_HOST="${FLOWGUARD_SKIP_INSTALL_HOST:-0}"

# Binaries shipped by @flowguard/core (see package.json "bin" field).
FLOWGUARD_BIN_NAMES=(
  "flowguard"
  "flowguard-mcp"
  "flowguard-hook-pre"
  "flowguard-hook-post"
  "flowguard-hook-session"
  "flowguard-hook-stop"
  "flowguard-hook-server"
)

# ─── Helpers ──────────────────────────────────────────────────────────────────

info() { echo "[FlowGuard Setup] $*"; }
warn() { echo "[FlowGuard Setup] WARN: $*" >&2; }
error() { echo "[FlowGuard Setup] ERROR: $*" >&2; exit 1; }

check_prereqs() {
  command -v node >/dev/null 2>&1 || error "Node.js not found. Codex cloud requires Node.js >= 20."
  command -v curl >/dev/null 2>&1 || error "curl not found. Required to download the release tarball."

  local node_version
  node_version=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [ "$node_version" -lt 20 ]; then
    error "Node.js >= 20 required (found: v${node_version})"
  fi
  info "Node.js $(node --version) detected"

  if [ -z "$FLOWGUARD_VERSION" ] && [ -z "$FLOWGUARD_TARBALL" ]; then
    error "FLOWGUARD_VERSION (e.g. 1.2.0-rc.3) or FLOWGUARD_TARBALL must be set."
  fi
}

# ─── Tarball Resolution ───────────────────────────────────────────────────────

# Resolves a local file path to a usable tarball, downloading if necessary.
# Writes the resolved path to stdout. Caller is responsible for cleanup.
resolve_tarball() {
  local tmp_tarball="/tmp/flowguard-core-install.tgz"

  if [ -n "$FLOWGUARD_TARBALL" ]; then
    case "$FLOWGUARD_TARBALL" in
      http://*|https://*)
        info "Downloading pre-staged tarball from ${FLOWGUARD_TARBALL}..." >&2
        curl -sSfL "$FLOWGUARD_TARBALL" -o "$tmp_tarball" \
          || error "Failed to download ${FLOWGUARD_TARBALL}"
        echo "$tmp_tarball"
        return
        ;;
      *)
        [ -f "$FLOWGUARD_TARBALL" ] \
          || error "FLOWGUARD_TARBALL='${FLOWGUARD_TARBALL}' does not exist"
        echo "$FLOWGUARD_TARBALL"
        return
        ;;
    esac
  fi

  local asset="flowguard-core-${FLOWGUARD_VERSION}.tgz"
  local tarball_url="https://github.com/${FLOWGUARD_REPO}/releases/download/v${FLOWGUARD_VERSION}/${asset}"
  local checksums_url="https://github.com/${FLOWGUARD_REPO}/releases/download/v${FLOWGUARD_VERSION}/checksums.sha256"

  info "Downloading ${asset} from ${tarball_url}..." >&2
  curl -sSfL "$tarball_url" -o "$tmp_tarball" \
    || error "Failed to download release asset ${asset}. Check FLOWGUARD_VERSION and FLOWGUARD_REPO."

  # Best-effort checksum verification. If the checksums file is unavailable
  # we still install, but warn loudly: the operator should investigate.
  local tmp_checksums="/tmp/flowguard-checksums.sha256"
  if curl -sSfL "$checksums_url" -o "$tmp_checksums" 2>/dev/null; then
    if grep -q " ${asset}\$" "$tmp_checksums"; then
      local expected actual
      expected=$(grep " ${asset}\$" "$tmp_checksums" | awk '{print $1}')
      actual=$(sha256sum "$tmp_tarball" | awk '{print $1}')
      if [ "$expected" != "$actual" ]; then
        rm -f "$tmp_tarball" "$tmp_checksums"
        error "Checksum mismatch for ${asset}: expected ${expected}, got ${actual}."
      fi
      info "Checksum verified (${actual:0:12}...)" >&2
    else
      warn "Checksum entry for ${asset} not found in checksums.sha256 — skipping verification."
    fi
    rm -f "$tmp_checksums"
  else
    warn "Could not fetch checksums.sha256 — installing without integrity verification."
  fi

  echo "$tmp_tarball"
}

# ─── Installation ─────────────────────────────────────────────────────────────

install_flowguard() {
  info "Installing FlowGuard core into ${FLOWGUARD_DIR}..."
  mkdir -p "${FLOWGUARD_DIR}"

  local tarball
  tarball=$(resolve_tarball)

  # Install the tarball as a local node_modules dependency. This populates
  # ${FLOWGUARD_DIR}/node_modules/@flowguard/core and the bin shims under
  # ${FLOWGUARD_DIR}/node_modules/.bin.
  ( cd "${FLOWGUARD_DIR}" && npm install --silent --no-save --omit=dev "$tarball" )

  info "FlowGuard core installed into ${FLOWGUARD_DIR}/node_modules/@flowguard/core"
}

# ─── Symlinks ─────────────────────────────────────────────────────────────────

create_symlinks() {
  info "Linking FlowGuard binaries into ${FLOWGUARD_BIN}..."
  mkdir -p "${FLOWGUARD_BIN}"

  local pkg_bin="${FLOWGUARD_DIR}/node_modules/.bin"
  [ -d "$pkg_bin" ] || error "Expected bin directory ${pkg_bin} not found after install."

  local linked=0
  for name in "${FLOWGUARD_BIN_NAMES[@]}"; do
    local src="${pkg_bin}/${name}"
    if [ ! -e "$src" ]; then
      warn "Binary ${name} not present in ${pkg_bin} — skipping"
      continue
    fi
    ln -sf "$src" "${FLOWGUARD_BIN}/${name}"
    info "  ${FLOWGUARD_BIN}/${name} -> ${src}"
    linked=$((linked + 1))
  done

  [ "$linked" -gt 0 ] || error "No FlowGuard binaries linked. Installation looks broken."
}

# ─── Host Wiring (flowguard install) ──────────────────────────────────────────

run_flowguard_install() {
  if [ "${FLOWGUARD_SKIP_INSTALL_HOST}" = "1" ]; then
    info "FLOWGUARD_SKIP_INSTALL_HOST=1 — skipping host wiring."
    return
  fi

  info "Running 'flowguard install' for host integration..."

  local flowguard_bin="${FLOWGUARD_BIN}/flowguard"
  [ -x "$flowguard_bin" ] || error "flowguard CLI not executable at ${flowguard_bin}"

  # The release tarball is consumed by 'flowguard install --core-tarball'
  # to provision the host (Codex) config. We point it at the installed
  # package payload, which the installer copies into the workspace vendor dir.
  local pkg_dir="${FLOWGUARD_DIR}/node_modules/@flowguard/core"
  local installed_tarball="${pkg_dir}/vendor/flowguard-core-installed.tgz"

  # If a tarball is already vendored (e.g. by the resolve step), reuse it;
  # otherwise re-pack the installed package so `--core-tarball` is satisfied.
  if [ ! -f "$installed_tarball" ]; then
    mkdir -p "$(dirname "$installed_tarball")"
    ( cd "$pkg_dir" && npm pack --silent --pack-destination "$(dirname "$installed_tarball")" >/dev/null )
    local packed
    packed=$(ls -1t "$(dirname "$installed_tarball")"/flowguard-core-*.tgz | head -n1)
    cp -f "$packed" "$installed_tarball"
  fi

  "$flowguard_bin" install \
    --host codex \
    --install-scope global \
    --core-tarball "$installed_tarball" \
    --force \
    || error "'flowguard install' failed. See output above for the fail-closed reason."
}

# ─── MCP Configuration ────────────────────────────────────────────────────────

# `flowguard install --host codex` writes the host MCP config. We only fall
# back to a minimal .codex/mcp.json here when the installer was skipped, so
# operators can still wire MCP manually for the workspace they invoked the
# script from.
configure_mcp_fallback() {
  if [ "${FLOWGUARD_SKIP_INSTALL_HOST}" != "1" ]; then
    return
  fi

  info "Writing minimal .codex/mcp.json fallback in ${PWD}/.codex/..."
  local mcp_dir="${PWD}/.codex"
  local mcp_config="${mcp_dir}/mcp.json"

  mkdir -p "$mcp_dir"

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

  info "MCP fallback written to ${mcp_config}"
}

# ─── Verification ─────────────────────────────────────────────────────────────

verify_installation() {
  info "Verifying installation..."

  local missing=0
  for name in "${FLOWGUARD_BIN_NAMES[@]}"; do
    if command -v "$name" >/dev/null 2>&1; then
      info "  ${name}: OK ($(command -v "$name"))"
    elif [ -x "${FLOWGUARD_BIN}/${name}" ]; then
      info "  ${name}: OK (${FLOWGUARD_BIN}/${name})"
    else
      warn "  ${name}: NOT FOUND"
      missing=$((missing + 1))
    fi
  done

  [ "$missing" -eq 0 ] || error "Installation incomplete: ${missing} expected binaries missing."

  if [ "${FLOWGUARD_SKIP_INSTALL_HOST}" != "1" ]; then
    info "Running 'flowguard doctor --install-scope global'..."
    "${FLOWGUARD_BIN}/flowguard" doctor --install-scope global \
      || warn "'flowguard doctor' reported issues. Review output above."
  fi

  info "Installation verified."
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  info "=== FlowGuard Codex Cloud Setup ==="
  info "Version: ${FLOWGUARD_VERSION:-<from FLOWGUARD_TARBALL>}"
  info "Repo:    ${FLOWGUARD_REPO}"
  info "Dir:     ${FLOWGUARD_DIR}"
  info "Bin:     ${FLOWGUARD_BIN}"
  info ""

  check_prereqs
  install_flowguard
  create_symlinks
  run_flowguard_install
  configure_mcp_fallback
  verify_installation

  info ""
  info "=== Setup complete ==="
  info "FlowGuard governance is ready for Codex cloud tasks."
}

main "$@"
