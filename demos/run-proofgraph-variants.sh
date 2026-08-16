#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

npx vitest run --project integration src/integration/e2e-workflow.test.ts -t "ProofGraph demo fixtures"
