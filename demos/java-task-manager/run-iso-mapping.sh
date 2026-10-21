#!/usr/bin/env bash
# Post-export ISO/IEC 27001:2022 evidence projection for the Java demo.
#
# This is a thin wrapper around `flowguard inspect --iso27001-mapping`. It does
# not calculate ISO statuses, does not call a model, and does not modify the
# exported evidence. It writes a JSON and a Markdown companion report outside
# the worktree and the FlowGuard config directory.
#
# Usage: ./run-iso-mapping.sh --session <host-session-id> [--output-root <dir>]
# Exit codes: 0 report produced; 1 usage/mapping/output/config error;
#             2 completion export missing or not verifiable.

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAPPING="$SCRIPT_DIR/iso27001-demo-mapping.json"
OUTPUT_ROOT="${TMPDIR:-/tmp}/flowguard-iso-reports"
SESSION=""

usage() {
  cat >&2 <<USAGE
Usage: $(basename "$0") --session <host-session-id> [--output-root <dir>]

Projects the verified completion export of one Java demo session onto the
synthetic ISO/IEC 27001:2022 demo mapping. Requires a prepared demo workspace
and an installed FlowGuard package (repo-scoped .opencode or global config).

Environment:
  FLOWGUARD_BIN       Optional explicit CLI command or path (highest priority)
  OPENCODE_CONFIG_DIR OpenCode config root for the global installation
  NODE                Node.js executable (default: node)

Output defaults to ${TMPDIR:-/tmp}/flowguard-iso-reports/<session-id>/
USAGE
}

die() {
  local message="$1"
  local code="${2:-1}"
  printf '[error] %s\n' "$message" >&2
  exit "$code"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --session)
      [ "$#" -ge 2 ] || die "--session requires a host session id"
      SESSION="$2"
      shift 2
      ;;
    --output-root)
      [ "$#" -ge 2 ] || die "--output-root requires a directory"
      OUTPUT_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$SESSION" ] || die "--session <host-session-id> is required"
case "$SESSION" in
  ses_*) ;;
  *) die "session id must start with 'ses_'" ;;
esac
case "$SESSION" in
  *[!A-Za-z0-9_-]*) die "session id contains unsafe characters" ;;
esac

[ -f "$MAPPING" ] || die "demo mapping not found: $MAPPING"
[ -f "pom.xml" ] || die "run this wrapper from the prepared Java demo workspace"

NODE_BIN="${NODE:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || die "Node.js is required but was not found"

WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
[ -n "$WORKTREE" ] || die "cannot resolve the workspace root"
WORKTREE="$(cd "$WORKTREE" && pwd -P)" || die "cannot resolve the workspace root"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

CLI_KIND=""
CLI_PATH=""
if [ -n "${FLOWGUARD_BIN:-}" ]; then
  if [ -f "$FLOWGUARD_BIN" ]; then
    case "$FLOWGUARD_BIN" in
      *.js) CLI_KIND="node"; CLI_PATH="$FLOWGUARD_BIN" ;;
      *) [ -x "$FLOWGUARD_BIN" ] || die "FLOWGUARD_BIN is not executable: $FLOWGUARD_BIN"; CLI_KIND="exec"; CLI_PATH="$FLOWGUARD_BIN" ;;
    esac
  elif command -v "$FLOWGUARD_BIN" >/dev/null 2>&1; then
    CLI_KIND="exec"
    CLI_PATH="$(command -v "$FLOWGUARD_BIN")"
  else
    die "FLOWGUARD_BIN does not resolve to an installed CLI: $FLOWGUARD_BIN"
  fi
else
  for candidate in \
    "$PWD/.opencode/node_modules/@flowguard/core/dist/cli/install.js" \
    "$CONFIG_DIR/node_modules/@flowguard/core/dist/cli/install.js" \
    "$PWD/node_modules/@flowguard/core/dist/cli/install.js"
  do
    if [ -f "$candidate" ]; then
      CLI_KIND="node"
      CLI_PATH="$candidate"
      break
    fi
  done
fi

[ -n "$CLI_PATH" ] || die "FlowGuard CLI not found. Run the demo setup/install first, or set FLOWGUARD_BIN."

CLI_VERSION=""
CLI_PACKAGE="$(cd "$(dirname "$CLI_PATH")/../.." 2>/dev/null && pwd)/package.json"
if [ -f "$CLI_PACKAGE" ]; then
  CLI_VERSION="$("$NODE_BIN" -e 'try{process.stdout.write(require(process.argv[1]).version||"")}catch{}' "$CLI_PACKAGE" 2>/dev/null || true)"
fi

OUTPUT_PARENT="$(cd "$(dirname "$OUTPUT_ROOT")" 2>/dev/null && pwd -P)" || die "output root parent does not exist: $(dirname "$OUTPUT_ROOT")"
OUTPUT_ROOT="$OUTPUT_PARENT/$(basename "$OUTPUT_ROOT")"
case "$OUTPUT_ROOT/" in
  "$WORKTREE/"*) die "output root must be outside the git worktree" ;;
esac
CONFIG_REAL="$(cd "$CONFIG_DIR" 2>/dev/null && pwd -P || true)"
if [ -n "$CONFIG_REAL" ]; then
  case "$OUTPUT_ROOT/" in
    "$CONFIG_REAL/"*) die "output root must be outside the FlowGuard config directory" ;;
  esac
fi
mkdir -p "$OUTPUT_ROOT" || die "cannot create output root: $OUTPUT_ROOT"

FINAL="$OUTPUT_ROOT/$SESSION"
[ ! -e "$FINAL" ] || die "refusing to overwrite existing report directory: $FINAL"

STAGE="$OUTPUT_ROOT/.staging-$SESSION-$$"
[ ! -e "$STAGE" ] || die "staging directory already exists: $STAGE"
mkdir "$STAGE" || die "cannot create staging directory: $STAGE"

FINAL_CLAIMED=""
cleanup() {
  rm -rf "$STAGE"
  if [ -n "$FINAL_CLAIMED" ]; then
    rm -rf "$FINAL"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

JSON_REPORT="$STAGE/iso27001-report.json"
MD_REPORT="$STAGE/iso27001-report.md"
SUMMARY="$STAGE/summary.txt"

run_cli() {
  if [ "$CLI_KIND" = "node" ]; then
    "$NODE_BIN" "$CLI_PATH" "$@"
  else
    "$CLI_PATH" "$@"
  fi
}

run_cli inspect --session "$SESSION" --iso27001-mapping "$MAPPING" --json --output "$JSON_REPORT" >/dev/null 2>"$STAGE/json.err"
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  cat "$STAGE/json.err" >&2
  case "$STATUS" in
    2) die "completion export is missing or not verifiable" 2 ;;
    *) die "FlowGuard inspect failed while producing the JSON report" 1 ;;
  esac
fi

run_cli inspect --session "$SESSION" --iso27001-mapping "$MAPPING" --output "$MD_REPORT" >/dev/null 2>"$STAGE/markdown.err"
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  cat "$STAGE/markdown.err" >&2
  case "$STATUS" in
    2) die "completion export is missing or not verifiable" 2 ;;
    *) die "FlowGuard inspect failed while producing the Markdown report" 1 ;;
  esac
fi

[ -s "$JSON_REPORT" ] || die "JSON report is missing or empty"
[ -s "$MD_REPORT" ] || die "Markdown report is missing or empty"

"$NODE_BIN" - "$JSON_REPORT" "$MD_REPORT" "$SUMMARY" <<'NODE'
const fs = require('node:fs');

const [, , jsonPath, markdownPath, summaryPath] = process.argv;
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

let report;
try {
  report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (error) {
  fail(`JSON report is not valid JSON: ${error.message}`);
}
const markdown = fs.readFileSync(markdownPath, 'utf8');

if (report.reportSchemaVersion !== 'iso27001-evidence-report.v1') {
  fail('JSON report has an unexpected schema version');
}
if (report.evidencePackage?.verification !== 'verified_snapshot') {
  fail('JSON report does not carry verified_snapshot evidence');
}
if (!Array.isArray(report.controls) || report.controls.length === 0) {
  fail('JSON report carries no projected controls');
}

const digests = {
  'report digest': report.reportDigest,
  'mapping digest': report.organization?.mappingDigest,
  'evidence package digest': report.evidencePackage?.packageSha256,
};
for (const [label, digest] of Object.entries(digests)) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    fail(`JSON report is missing a valid ${label}`);
  }
  if (!markdown.includes(digest)) {
    fail(`JSON and Markdown reports do not share the same ${label}`);
  }
}

const mappedControls = report.controls.filter(
  (control) => Array.isArray(control?.rules) && control.rules.length > 0,
);
if (mappedControls.length === 0) {
  fail('JSON report contains no mapped controls');
}
const lines = [
  'ISO/IEC 27001:2022 Evidence Projection',
  '',
  `Export:     ${report.evidencePackage.verification}`,
  `Report:     ${report.reportSchemaVersion}`,
  `SoA:        ${report.soaVerification}`,
  '',
  'Controls:',
];
for (const control of mappedControls) {
  const controlId = control?.controlRef?.controlId;
  const status = control?.status;
  if (typeof controlId !== 'string' || typeof status !== 'string') {
    fail('JSON report contains an invalid control projection');
  }
  lines.push(`  ${controlId.padEnd(10)} ${status}`);
}
const unmappedCount = report.controls.length - mappedControls.length;
if (unmappedCount > 0) {
  lines.push(
    '',
    `Other candidate controls: ${unmappedCount} NOT_MAPPED (informational; see report)`,
  );
}
lines.push(
  '',
  `Evidence package SHA-256: ${report.evidencePackage.packageSha256}`,
  `Mapping SHA-256:          ${report.organization.mappingDigest}`,
  `Report digest:            ${report.reportDigest}`,
  '',
  'Evidence-to-control mapping only.',
  'Not an ISO conformity assessment.',
);
fs.writeFileSync(summaryPath, `${lines.join('\n')}\n`);
NODE
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  die "JSON/Markdown report validation failed" 1
fi

mkdir "$FINAL" 2>/dev/null || die "refusing to overwrite existing report directory: $FINAL"
FINAL_CLAIMED=1
if ! mv "$JSON_REPORT" "$FINAL/iso27001-report.json" || ! mv "$MD_REPORT" "$FINAL/iso27001-report.md"; then
  die "cannot publish the completed reports" 1
fi
FINAL_CLAIMED=""
trap - EXIT HUP INT TERM

if [ -n "$CLI_VERSION" ]; then
  printf 'FlowGuard CLI: %s (%s)\n' "$CLI_PATH" "$CLI_VERSION"
else
  printf 'FlowGuard CLI: %s\n' "$CLI_PATH"
fi
cat "$SUMMARY"
printf '\n%s\n' "Report directory: $FINAL"
printf '%s\n' "JSON:     $FINAL/iso27001-report.json"
printf '%s\n' "Markdown: $FINAL/iso27001-report.md"
rm -rf "$STAGE"
exit 0
