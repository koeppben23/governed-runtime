import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const workspaceRoot = process.cwd();
if (!existsSync(path.join(workspaceRoot, 'dist', 'cli', 'install.js'))) {
  console.error('dist/cli/install.js missing. Run npm run build before independent-review e2e.');
  process.exit(1);
}
const tmpDir = mkdtempSync(path.join(tmpdir(), 'fg-independent-review-'));
const outputFile = path.join(tmpDir, 'vitest-independent-review.json');

const testFiles = [
  'src/integration/plugin.test.ts',
  'src/integration/tools-execute-planning.test.ts',
  'src/integration/tools-execute-ticket.test.ts',
  'src/integration/tools-execute-review.test.ts',
  'src/integration/tools-execute-p26.test.ts',
  'src/integration/tools-execute-implement.test.ts',
  'src/integration/tools-execute-run-check.test.ts',
  'src/integration/tools-execute-review-flow.test.ts',
  'src/integration/tools-execute-abort-session.test.ts',
  'src/integration/tools-execute-archive.test.ts',
  'src/integration/tools/review-validation-findings.test.ts',
  'src/cli/opencode-reviewer-capture-live.smoke.test.ts',
  'src/cli/opencode-native-install.smoke.test.ts',
];

// The two positive product contracts are unchanged. They now run against the
// actual native host/product, never an SDK callback mock or a fail-closed negative.
const mustPassTestTitles = [
  'leaves the review-required output pending and authorizes the native Task before release',
  'records bound same-child evidence and fulfills the obligation',
  'accepts when strict evidence and attestation match',
  'blocks when strict attestation is missing',
  'blocks when strict obligation is blocked',
  'blocks when submitted findings session differs from invocation child session',
  'Mode B changes_requested keeps selfReviewIteration aligned with next iteration metadata',
  // Packed native install, real command/tool inventory, reload and uninstall
  // replace the removed V1 config/API catalogue verifier (not reviewer proof).
  'loads exactly one installed definition, reloads it, and unloads after uninstall without rewriting customer config',
  'rejects a tool call during actual same-child serialization before its output reaches the provider',
  'keeps caller recovery claims from unlocking an unknown outcome and recovers only through a fresh native attempt',
];
const testTitleFilter = mustPassTestTitles
  .map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

try {
  // Resolve the local package's declared executable, not an npm shell shim.
  // cmd.exe must never parse the test-name filter's pipes or metacharacters.
  const vitestManifestPath = createRequire(path.join(workspaceRoot, 'package.json')).resolve(
    'vitest/package.json',
  );
  const vitestManifest = JSON.parse(readFileSync(vitestManifestPath, 'utf8'));
  if (typeof vitestManifest.bin?.vitest !== 'string')
    throw new Error('The local Vitest package has no declared CLI executable.');
  const vitestCli = path.resolve(path.dirname(vitestManifestPath), vitestManifest.bin.vitest);
  const run = spawnSync(
    process.execPath,
    [
      vitestCli,
      'run',
      '--project',
      'integration',
      '--project',
      'smoke',
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
      shell: false,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        OPENCODE_CONFIG_DIR: path.join(tmpDir, 'config'),
        FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
        FLOWGUARD_OPENCODE_HOST_E2E: '1',
      },
    },
  );
  if (run.status !== 0) {
    console.error('Independent-review native verification failed.', run.error ?? '');
    process.exitCode = run.status ?? 1;
  }
  // A nonzero runner may still have a useful report. Surface the exact missing
  // or failing contracts without replacing the runner's original failure code.
  const report = JSON.parse(readFileSync(outputFile, 'utf8'));
  const assertions = (report.testResults ?? []).flatMap((result) => result.assertionResults ?? []);
  const failedRequired = mustPassTestTitles.filter((title) => {
    const matches = assertions.filter((assertion) => assertion.title === title);
    return matches.length !== 1 || matches[0].status !== 'passed';
  });
  if (failedRequired.length > 0) {
    console.error(
      'Independent-review strict verification failed. Required tests missing/pending/ambiguous:',
    );
    for (const title of failedRequired) console.error(` - ${title}`);
    process.exitCode ??= 1;
  } else if (run.status === 0) {
    console.log('Independent-review e2e verification passed.');
  }
} catch (error) {
  console.error('Independent-review verification could not establish a result:', error);
  process.exitCode ??= 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
