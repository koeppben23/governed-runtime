import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workspaceRoot = process.cwd();
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fg-independent-review-'));
const outputFile = path.join(tmpDir, 'vitest-independent-review.json');

const testFiles = [
  'src/integration/plugin.test.ts',
  'src/integration/tools-execute.test.ts',
  'src/integration/tools/review-validation.test.ts',
];

const mustPassTestTitles = [
  'fulfills strict obligation and mutates output when attestation is valid',
  'accepts when strict evidence and attestation match',
  'blocks when strict attestation is missing',
  'blocks when strict obligation is blocked',
  'Mode B changes_requested keeps selfReviewIteration aligned with next iteration metadata',
];

const testTitleFilter = mustPassTestTitles
  .map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const run = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'vitest',
    'run',
    ...testFiles,
    '--testNamePattern',
    `(${testTitleFilter})`,
    '--reporter=json',
    `--outputFile=${outputFile}`,
    '--passWithNoTests=false',
  ],
  {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '0' },
  },
);

if (run.status !== 0) {
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}

let report;
try {
  report = JSON.parse(readFileSync(outputFile, 'utf-8'));
} catch (error) {
  console.error('Failed to parse Vitest JSON report:', error);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}

const assertionResults = [];
for (const testResult of report.testResults ?? []) {
  for (const assertion of testResult.assertionResults ?? []) {
    assertionResults.push(assertion);
  }
}

const failedRequired = mustPassTestTitles.filter((title) => {
  const match = assertionResults.find((assertion) => assertion.title === title);
  return !match || match.status !== 'passed';
});

if (failedRequired.length > 0) {
  console.error('Independent-review strict verification failed. Required tests missing/pending:');
  for (const title of failedRequired) {
    console.error(` - ${title}`);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}

console.log('Independent-review e2e verification passed.');
rmSync(tmpDir, { recursive: true, force: true });
