/** Active V2 demo preflight; candidate selection is not product certification. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CANDIDATE_FILE = '.sdk-baselines/opencode/cli-candidate.json';

class DemoToolchainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Read only the current candidate authority; never fall back to a V1 pin. */
export function readPins(repo = REPO) {
  const candidate = JSON.parse(fs.readFileSync(path.join(repo, CANDIDATE_FILE), 'utf8'));
  if (
    candidate?.package !== '@opencode/cli' ||
    candidate.status !== 'candidate' ||
    typeof candidate.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(candidate.version)
  ) {
    throw new DemoToolchainError('OPENCODE_CANDIDATE_INVALID', `Invalid ${CANDIDATE_FILE}`);
  }
  const node = fs.readFileSync(path.join(repo, '.node-version'), 'utf8').trim();
  if (!node) throw new DemoToolchainError('NODE_PIN_INVALID', '.node-version is empty');
  return { opencode: candidate.version, node };
}

export function assertToolchain(pins) {
  const problems = [];
  const nodeVersion = process.versions.node;
  if (nodeVersion !== pins.node) {
    problems.push(`node ${nodeVersion} != pinned ${pins.node} (.node-version)`);
  }
  const opencodeVersion = execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim();
  if (opencodeVersion !== `opencode v${pins.opencode}`) {
    problems.push(
      `opencode reported ${opencodeVersion} != candidate opencode v${pins.opencode} (${CANDIDATE_FILE})`,
    );
  }
  if (problems.length > 0) {
    throw new DemoToolchainError(
      'DEMO_TOOLCHAIN_MISMATCH',
      `toolchain pin mismatch:\n- ${problems.join('\n- ')}`,
    );
  }
  return { nodeVersion, opencodeVersion };
}
