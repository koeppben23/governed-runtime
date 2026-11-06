/** Component-only mock of the scoped decision-authority port. Never native/operator proof. */
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ReviewVerdict } from '../state/evidence.js';
import * as authority from './workflow-decision-invocation.js';
import { WorkflowDecisionOperation } from '../state/governance-activation.js';
import { computeStateDigest } from './audit-outbox.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { makeProgressedState } from '../fixtures.js';
import type { SessionAuthorityResolution } from '../adapters/session-authority.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import {
  messageCaptureFixture,
  nativeProvenanceFixture,
} from '../review-invocation-test-helpers.js';

/** Seed core review evidence only; real host decision/activation tests must label this boundary. */
export async function prepareComponentDecisionGate(
  bound: Extract<SessionAuthorityResolution, { status: 'resolved' }>,
  exhausted = false,
) {
  const fixture = makeProgressedState('ARCH_REVIEW');
  const reviewAssurance = !exhausted
    ? fixture.reviewAssurance
    : {
        ...fixture.reviewAssurance!,
        invocations: fixture.reviewAssurance!.invocations.map((invocation) => {
          const findings = {
            ...invocation.capturedRawFindings,
            overallVerdict: 'changes_requested',
          };
          const capture = messageCaptureFixture({
            childSessionId: invocation.childSessionId,
            obligationId: invocation.obligationId,
            attemptId: invocation.attemptId,
            findings,
          });
          return {
            ...invocation,
            capturedVerdict: 'changes_requested' as const,
            capturedRawFindings: findings,
            findingsHash: hashText(canonicalJsonStringify(findings)),
            capture,
            nativeProvenance: nativeProvenanceFixture(capture, invocation.childSessionId),
          };
        }),
      };
  return writeStateWithArtifacts(bound.sessDir, {
    ...fixture,
    id: bound.state.id,
    flowguardSessionId: bound.state.flowguardSessionId,
    binding: bound.state.binding,
    policySnapshot: bound.state.policySnapshot,
    reviewAssurance,
    ...(exhausted
      ? {
          architecture: { ...fixture.architecture!, reviewCompletion: 'review_exhausted' as const },
        }
      : {}),
  });
}

const fixtures = new Map<
  string,
  { verdict: ReviewVerdict; invocation?: authority.DecisionInvocation }
>();
export function recordComponentDecision(input: {
  sessionId: string;
  expectedVerdict: ReviewVerdict;
  command?: string;
}): void {
  fixtures.set(input.sessionId, { verdict: input.expectedVerdict });
  vi.spyOn(authority, 'readDecisionInvocation').mockImplementation((probe) => {
    const fixture = fixtures.get(probe.context.sessionID);
    if (!fixture) return undefined;
    fixture.invocation ??= {
      committed: false,
      assertScopeCurrent: async () => {},
      operation: WorkflowDecisionOperation.parse({
        sessionId: probe.context.sessionID,
        rootSessionId: probe.context.sessionID,
        activationId: randomUUID(),
        generation: 1,
        directory: probe.context.worktree,
        worktreeRoot: probe.context.worktree,
        policyDigest: probe.state.policySnapshot.hash,
        operationId: randomUUID(),
        source: 'host_command',
        stateDigest: computeStateDigest(probe.state),
        verdict: fixture.verdict,
        rationaleDigest: hashText(probe.rationale),
      }),
    };
    return fixture.invocation;
  });
}
export function clearComponentDecisions(): void {
  fixtures.clear();
}
export function peekComponentDecision(input: { sessionId: string; verdict: ReviewVerdict }) {
  const fixture = fixtures.get(input.sessionId);
  return {
    ok:
      fixture !== undefined &&
      fixture.verdict === input.verdict &&
      fixture.invocation?.committed !== true,
  };
}
