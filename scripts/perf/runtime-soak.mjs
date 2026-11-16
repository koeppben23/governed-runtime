/**
 * Bounded lifecycle soak for workspace and settled-dispatch maps.
 *
 * npm run build
 * SOAK_ITERATIONS=10000 node scripts/perf/runtime-soak.mjs
 *
 * This is a synthetic map/RSS soak, not a real multi-hour host run. It proves
 * that repeated session and reviewer lifecycle churn releases full objects and
 * keeps the bounded identity sets at their configured cap.
 */
import { performance } from 'node:perf_hooks';
import { PluginWorkspaceImpl } from '../../dist/integration/plugin-workspace.js';
import {
  MAX_ENROLLED_REVIEWER_BINDINGS,
  retireSettledDispatch,
} from '../../dist/integration/opencode-governance-dispatch-cache.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../dist/shared/flowguard-identifiers.js';

const iterations = Number(process.env.SOAK_ITERATIONS ?? '10000');
const workspace = new PluginWorkspaceImpl({ auditWorktree: process.cwd() });
const dispatchMemory = {
  dispatches: new Map(),
  dispatchChildren: new Map(),
  linking: new Map(),
  settledReviewerDispatches: new Set(),
  enrolledReviewerDispatchKeys: new Set(),
};

const started = performance.now();
for (let index = 0; index < iterations; index++) {
  const sessionId = `ses_soak_${index}`;
  workspace.getChainState(sessionId);
  workspace.getEnforcementState(sessionId);
  workspace.invalidateChainState(sessionId);
  workspace.releaseEnforcementState(sessionId);

  const key = `reviewer_${index}`;
  dispatchMemory.dispatches.set(key, { agent: REVIEWER_SUBAGENT_TYPE });
  dispatchMemory.dispatchChildren.set(key, `child_${index}`);
  retireSettledDispatch(dispatchMemory, key, `child_${index}`, true);
}
const elapsedMs = performance.now() - started;
const internal = workspace;
const result = {
  benchmark: 'runtime-lifecycle-soak',
  iterations,
  elapsedMs: Number(elapsedMs.toFixed(1)),
  workspace: {
    chainStates: internal._chainStates.size,
    enforcementStates: internal._enforcementStates.size,
    sessionQueues: internal._sessionQueues.size,
  },
  dispatchMemory: {
    dispatches: dispatchMemory.dispatches.size,
    dispatchChildren: dispatchMemory.dispatchChildren.size,
    linking: dispatchMemory.linking.size,
    settledReviewerDispatches: dispatchMemory.settledReviewerDispatches.size,
    enrolledReviewerDispatchKeys: dispatchMemory.enrolledReviewerDispatchKeys.size,
    cap: MAX_ENROLLED_REVIEWER_BINDINGS,
  },
  rss: process.memoryUsage().rss,
  result:
    internal._chainStates.size === 0 &&
    internal._enforcementStates.size === 0 &&
    internal._sessionQueues.size === 0 &&
    dispatchMemory.dispatches.size === 0 &&
    dispatchMemory.dispatchChildren.size === 0 &&
    dispatchMemory.linking.size === 0 &&
    dispatchMemory.settledReviewerDispatches.size <= MAX_ENROLLED_REVIEWER_BINDINGS &&
    dispatchMemory.enrolledReviewerDispatchKeys.size <= MAX_ENROLLED_REVIEWER_BINDINGS
      ? 'PASS'
      : 'FAIL',
  scope: 'synthetic map/RSS soak; real multi-hour host acceptance remains NOT_VERIFIED',
};
console.log(JSON.stringify(result));
if (result.result !== 'PASS') process.exitCode = 1;
