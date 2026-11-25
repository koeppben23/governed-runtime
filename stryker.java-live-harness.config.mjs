/** Target the Java demo's command witnesses and the boundaries that credit them. */
import { readFileSync } from 'node:fs';

const base = JSON.parse(readFileSync(new URL('./stryker.conf.json', import.meta.url), 'utf8'));
const demo = 'demos/java-task-manager';
const tests = 'src/documentation/__tests__';

function range(module, start, end, directory = demo) {
  const file = `${directory}/${module}.mjs`;
  const lines = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').split('\n');
  const first = lines.findIndex((line) => line.includes(start));
  const next = lines.findIndex((line, index) => index > first && line.includes(end));
  if (first < 0 || next < 0)
    throw new Error(`Unknown mutation range in ${file}: ${start} … ${end}`);
  return `${file}:${first + 1}-${next}`;
}

export default {
  ...base,
  checkers: [],
  // Keep the shared thresholds, but require strictly more than 80% here.
  thresholds: { ...base.thresholds, break: 80.01 },
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.ts', related: false },
  testFiles: [
    'java-demo-harness-hardening',
    'java-demo-contract',
    'java-demo-native-witness',
    'java-demo-plan-preflight',
    'demo-rearm-lifecycle',
    'demo-audit-witness',
    'demo-recovery-state',
    'live-claim-controls',
  ].map((name) => `${tests}/${name}.test.ts`),
  mutate: [
    `${demo}/live-decision-witness.mjs`,
    `${demo}/live-native-command-witness.mjs`,
    `${demo}/live-plan-preflight.mjs`,
    'demos/lib/review-recovery-authority.mjs',
    'demos/lib/product-transition.mjs',
    range(
      'recovery-state',
      'function acceptingReview(',
      'function ticketContentDigest(',
      'demos/lib',
    ),
    range(
      'recovery-state',
      'function ticketAdoptionPersisted(',
      'An unrelated phase, audit or metadata update',
      'demos/lib',
    ),
    range(
      'run-live-claim-controls',
      'export function assertPostTaskAdoption',
      'export function assertRetainedCriticalClaim',
    ),
    `${demo}/live-claim-plan-candidate.mjs`,
    range(
      'live-host-transport',
      'export async function hostNativeCommandTransport',
      'export async function hostCommandTransport',
    ),
    range(
      'live-host-transport',
      'options.expectedPlanGate &&',
      'const auditBefore = readAuditEvents',
    ),
    range('live-runner', 'const preflights =', 'if (session.pendingReviewRecovery)'),
    range('live-runner', 'expectedTargetPhase: targetPhase,', '/**'),
  ],
  jsonReporter: { fileName: 'reports/mutation/java-live-harness/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/java-live-harness/mutation.html' },
};
