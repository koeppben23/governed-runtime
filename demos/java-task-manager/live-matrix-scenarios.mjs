/** The six Java matrix scenarios and their externally observed outcomes. */
import path from 'node:path';
import { DemoNotVerifiedError, exitCodeForResults } from '../lib/results.mjs';
import { readAuditEvents } from '../lib/recovery-state.mjs';
import { lastAuditSequence } from './live-session-evidence.mjs';
/** Dedicated, untouched seed copy the architecture negative probe governs. */
export const NEGATIVE_PROBE_WORKSPACE = 'java-task-manager-architecture-negative';

/**
 * Controlled negative steps of the architecture-negative flow, each bound to
 * the ONE typed denial the runner expects and asserts. The latency analyzer
 * classifies a denial as a controlled negative only for the exact (step, code)
 * pair declared here; a different code inside a control step stays a real
 * defect instead of being laundered as part of the control.
 *
 * `architecture-negative-04-approve` only expects a denial on the exhausted
 * branch; the converged branch performs the ordinary approval instead.
 */
export const CONTROLLED_NEGATIVE_STEPS = new Map([
  ['architecture-negative-02-probe', 'ARCHITECTURE_CLAIM_INVALID'],
  ['architecture-negative-04-approve', 'GOVERNANCE_OVERRIDE_REQUIRED'],
]);
/** Non-zero when any requested flow did not produce accepted evidence. */
export function matrixExitCode(flows) {
  return exitCodeForResults(flows);
}
/**
 * Negative-probe precondition: the controlled probe is only meaningful on a
 * pristine READY session with no architecture record. If the agent already
 * performed architecture work (observed live: the whole flow ran inside the
 * /start turn), the scenario is no longer clean -> NOT_VERIFIED.
 */
export function assertArchitectureProbePrecondition(state) {
  if (state.architecture !== null || state.phase !== 'READY') {
    throw new DemoNotVerifiedError(
      'the agent performed architecture work before the controlled probe; ' +
        'the negative-probe precondition is violated (the scenario is not clean); ' +
        'the proof is NOT_VERIFIED',
    );
  }
}

/**
 * Step-local mutation check: the rejected probe call must not change the
 * architecture digest or the phase, and must not write state or run a
 * transition in the audit trail (which would also catch an intermediate
 * mutation that was reverted before the post-state was read).
 */
export function architectureProbeMutated(before, after, auditEvents) {
  const beforeDigest = before.architecture?.digest ?? null;
  const afterDigest = after.architecture?.digest ?? null;
  if (beforeDigest !== afterDigest) return true;
  if (before.phase !== after.phase) return true;
  return auditEvents.some(
    (event) =>
      event?.event === 'state_write' || String(event?.event ?? '').startsWith('transition:'),
  );
}
async function runDevelopment(runner, session) {
  await runner.turn(session, 'development-02-task', '/task --file TICKET.md');
  await runner.turn(session, 'development-03-plan', '/plan');
  await runner.approve(session, 'development-04-approve-plan', 'PLAN_REVIEW');
  await runner.turn(session, 'development-05-implement', '/implement');
  await runner.completeImplementationReview(session, 'development-05-implement');
  await runner.approve(session, 'development-06-approve-impl', 'EVIDENCE_REVIEW');
  await runner.turn(session, 'development-07-finish', '/finish');
  await runner.turn(session, 'development-08-export', '/export');
  const first = runner.verifyPackage(
    session,
    'export',
    'development',
    'EXPORT_READY',
    'development',
  );
  await runner.turn(session, 'development-09-archive', '/archive');
  const after = runner.verifyPackage(
    session,
    'export',
    'development',
    'EXPORT_READY',
    'development',
  );
  if (first.sha256 !== after.sha256) throw new Error('development: export changed after /archive');
  session.packages = [after];
}

async function runReduced(runner, session, label, ticket) {
  await runner.turn(session, `${label}-02-task`, `/task --file ${ticket}`);
  await runner.turn(session, `${label}-03-plan`, '/plan');
  await runner.approve(session, `${label}-04-approve-plan`, 'PLAN_REVIEW');
  await runner.turn(session, `${label}-05-implement`, '/implement');
  await runner.completeImplementationReview(session, `${label}-05-implement`);
  await runner.approve(session, `${label}-06-approve-impl`, 'EVIDENCE_REVIEW');
  await runner.turn(session, `${label}-07-export`, '/export');
  session.packages = [
    runner.verifyPackage(session, 'export', 'development', 'EXPORT_READY', label),
  ];
}

export async function runFlows(runner) {
  const { workspaces, configDir } = runner;
  const mainWorkspace = path.join(workspaces, 'java-task-manager');
  const reducedRoot = path.join(workspaces, 'reduced-ceremony');
  // The negative probe reviews against the untouched seed. The development flow
  // modifies the main workspace, so the probe gets its own pristine copy: a
  // reviewer comparing a post-fix ADR against the frozen base would otherwise
  // reject a correct decision.
  const negativeWorkspace = path.join(workspaces, NEGATIVE_PROBE_WORKSPACE);

  const flows = {
    architecture: {
      workspace: mainWorkspace,
      terminal: 'ARCH_COMPLETE',
      run: async (session) => {
        await runner.turn(
          session,
          'architecture-02-architecture',
          '/architecture Read ADR_TICKET.md and TICKET.md, then create an ADR based on them. Record ProofGraph claims using the architecture claim fields (statement, critical, authoritySectionId, requiredReviewEvidence). If a claim submission is rejected, read the recovery guidance and resubmit corrected claims.',
        );
        await runner.approve(session, 'architecture-03-approve', 'ARCH_REVIEW');
        await runner.turn(
          session,
          'architecture-04-archive',
          '/archive redactionMode=none includeRaw=true',
        );
        session.packages = [
          runner.verifyPackage(session, 'archive', 'architecture', 'ARCH_COMPLETE', 'architecture'),
        ];
      },
    },
    development: {
      workspace: mainWorkspace,
      terminal: 'COMPLETE',
      run: (session) => runDevelopment(runner, session),
    },
    'peer-review': {
      workspace: mainWorkspace,
      terminal: 'PEER_REVIEW_COMPLETE',
      run: async (session) => {
        await runner.turn(session, 'peer-review-02-review', '/review branch=feature/add-due-date');
        await runner.turn(
          session,
          'peer-review-03-archive',
          '/archive redactionMode=none includeRaw=true',
        );
        session.packages = [
          runner.verifyPackage(
            session,
            'archive',
            'peer-review',
            'PEER_REVIEW_COMPLETE',
            'peer-review',
          ),
        ];
      },
    },
    'reduced-on': {
      workspace: path.join(reducedRoot, 'reduced-on'),
      terminal: 'COMPLETE',
      preflight: ['--verify-session', path.join(reducedRoot, 'reduced-on')],
      run: (session) => runReduced(runner, session, 'reduced-on', 'TICKET_DOCS.md'),
    },
    'reduced-off': {
      workspace: path.join(reducedRoot, 'reduced-off'),
      terminal: 'COMPLETE',
      preflight: ['--verify-session', path.join(reducedRoot, 'reduced-off')],
      run: (session) => runReduced(runner, session, 'reduced-off', 'TICKET_DOCS.md'),
    },
    'architecture-negative': {
      workspace: negativeWorkspace,
      terminal: 'ARCH_COMPLETE',
      run: async (session) => {
        // Controlled negative step: the exact typed denial must be observed and
        // nothing may be persisted before the allowed recovery continues.
        const preProbe = runner.requireBoundState(session);
        assertArchitectureProbePrecondition(preProbe.state);
        const probeAuditFloor = lastAuditSequence(runner.configDir, session.sessionId);
        await runner.turn(
          session,
          'architecture-negative-02-probe',
          'Call flowguard_architecture exactly once with a minimal ADR (title Negative-Path Probe, adrText with the sections ## Context, ## Decision, ## Consequences) and EXACTLY this intentionally invalid plan-shaped claims array: [{"statement":"probe plan-shaped claim","claimScope":"specific_behavior","expectedCheckId":"probe","critical":true}]. Report the typed rejection code, do not resubmit in this step, and stop.',
          { expectedDenial: CONTROLLED_NEGATIVE_STEPS.get('architecture-negative-02-probe') },
        );
        const postProbe = runner.requireBoundState(session);
        const probeAuditEvents = readAuditEvents(postProbe.sessionDir).filter(
          (event) => (Number(event?.auditSequence) || 0) > probeAuditFloor,
        );
        if (architectureProbeMutated(preProbe.state, postProbe.state, probeAuditEvents)) {
          throw new Error(
            'the rejected architecture probe mutated persisted state; stopping the flow',
          );
        }
        await runner.turn(
          session,
          'architecture-negative-03-recovery',
          '/architecture Read ADR_TICKET.md and TICKET.md and create a complete ticket-aligned Service-Layer Null-Safety ADR, including the required options, trade-offs, consequences and falsifiable validation path. Submit schema-valid architecture claims about that ADR using statement, critical, authoritySectionId and requiredReviewEvidence. The preceding invalid-claim probe is separate runner evidence, not the ADR subject and not repository evidence for its claims. Complete the full fresh independent review normally; correct substantive blocking findings and stop at the ordinary approval gate. Do not use a governance override.',
        );
        const afterRecovery = runner.requireBoundState(session);
        if (afterRecovery.state.architecture?.reviewCompletion === 'review_exhausted') {
          // Negative contract: an exhausted independent review must NOT be
          // approvable by a plain /approve, and the refusal must not mutate
          // the gate. A successful recovery to ARCH_COMPLETE is a different
          // proof and stays on the converged branch below.
          await runner.turn(session, 'architecture-negative-04-approve', undefined, {
            command: 'approve',
            expectedDenial: CONTROLLED_NEGATIVE_STEPS.get('architecture-negative-04-approve'),
            expectedDenialTool: 'flowguard_decision',
          });
          const refused = runner.requireBoundState(session);
          if (
            refused.state.phase !== 'ARCH_REVIEW' ||
            refused.state.architecture?.status === 'accepted'
          ) {
            throw new Error('the refused plain approve mutated the exhausted architecture gate');
          }
          session.negativeOutcome = 'exhausted_plain_approve_refused';
          return;
        }
        await runner.approve(session, 'architecture-negative-04-approve', 'ARCH_REVIEW');
        await runner.turn(
          session,
          'architecture-negative-05-archive',
          '/archive redactionMode=none includeRaw=true',
        );
        session.packages = [
          runner.verifyPackage(
            session,
            'archive',
            'architecture',
            'ARCH_COMPLETE',
            'architecture-negative',
          ),
        ];
      },
      negativeOutcomes: ['exhausted_plain_approve_refused'],
    },
  };
  return flows;
}
