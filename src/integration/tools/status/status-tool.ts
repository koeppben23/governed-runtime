/**
 * @module integration/tools/status/status-tool
 * @description FlowGuard status tool — read-only session state check.
 *
 * Returns phase, evidence summary, policy info, completeness matrix,
 * and next action. Does NOT mutate state.
 *
 * Supports focused projections via optional boolean flags:
 * whyBlocked, evidence, context, readiness.
 *
 * @version v2 (extracted projection dispatch and full status builder)
 */

import { z } from 'zod';

import type { ToolDefinition } from '../helpers.js';
import { formatError } from '../error-format.js';
import { formatBlocked } from '../../blocked-result.js';
import {
  resolveWorkspacePaths,
  withReadOnlySession,
  enrichWithWorkflowDirective,
} from '../helpers.js';

import type { SessionState } from '../../../state/schema.js';
import { authorizedCriticalPlanClaimIds } from '../../../state/proofgraph-approval.js';
import { resolveRuntimeWithProfileIds } from './status-provider-projection.js';
import type { FlowGuardPolicy } from '../../../config/policy.js';
import { readReport } from '../../../adapters/persistence.js';
import { readConfig } from '../../../adapters/persistence-config.js';
import type { PresentationRenderOptions } from '../../../presentation/glyph-profile.js';

// State & Machine
import { evaluate } from '../../../machine/evaluate.js';

// Adapters
import { ActorClaimError } from '../../../adapters/actor.js';

// Config
import { evaluateCompleteness } from '../../../audit/completeness.js';
import {
  summarizePersistedProofGraph,
  summarizeProofGraph,
} from '../../../audit/proofgraph/summary.js';
import {
  evaluateStructuralSurfaces,
  bindStructuralEvidence,
  surfaceDigestMap,
} from '../../proofgraph/structural-provider.js';
import {
  loadMutationReport,
  evaluateMutationProfiles,
  resolveVerifiedMutationVerdicts,
} from '../../proofgraph/mutation-provider.js';
import { bindMutationEvidence } from '../../../audit/proofgraph/mutation-binder.js';
import { checkRegistrationConsistency } from '../../proofgraph/registration-consistency.js';
import { checkConfigDefaultConsistency } from '../../proofgraph/config-default-consistency.js';
import { evaluateProofGraphGate, planClaimAuthorityOf } from '../../../audit/proofgraph/gate.js';
import { buildProofApprovalProjection } from '../../proofgraph/approval-projection.js';
import { buildStatusProjection } from '../../status.js';
import {
  buildEvidenceDetailProjection,
  buildBlockedProjection,
  buildContextProjection,
  buildReadinessProjection,
} from '../../status-detail-projections.js';
import { buildFinishCard } from '../../status-finish.js';
import {
  buildWhyPresentationProjection,
  buildFinishPresentationProjection,
} from '../../status-why-finish.js';
import { buildDiscoveryDriftStatus } from '../../discovery-drift-status.js';
import { buildNoSessionDocument } from '../../status-presentation.js';
import { buildWhyDocument } from '../../why-presentation.js';
import { buildFinishDocument } from '../../finish-presentation.js';
import { renderMarkdown } from '../../../presentation/index.js';
import { emitDetailRequested } from '../presentation-telemetry.js';
import {
  buildFullStatusResponse,
  buildIdentityField,
  loadDiscoveryStatusContext,
} from './status-full-response.js';

// ─── Projection dispatch ──────────────────────────────────────────────────────

interface StatusArgs {
  whyBlocked?: boolean;
  evidence?: boolean;
  context?: boolean;
  readiness?: boolean;
  finish?: boolean;
  proofGraph?: boolean;
}

/**
 * Cheap, SessionState-derived verification-check fields that the /check,
 * /validate, and /implement command prompts read to decide whether to run
 * flowguard_run_check. These are included in EVERY focused projection (not just
 * the full projection) because a focused status call (e.g. whyBlocked:true) must
 * not silently strip the exact fields those prompts gate on — otherwise a
 * VALIDATION session looks like it has "no active checks" and can never advance.
 *
 * Intentionally excludes the EXPENSIVE full-only fields (discoveryHealth,
 * discoveryDrift, implementationGuidance, detectedStack) which require reading
 * the persisted discovery artifact; those stay full-projection-only.
 *
 * Check readiness is projected solely by buildStatusProjection (status.ts).
 */
function buildCheckProjectionFields(
  state: SessionState,
  policy: FlowGuardPolicy,
): Record<string, unknown> {
  const { remainingChecks } = buildStatusProjection(state, policy);
  return {
    activeChecks: remainingChecks ?? [],
    verificationCandidates: state.verificationCandidates ?? [],
    ...(remainingChecks !== undefined ? { remainingChecks } : {}),
  };
}

/**
 * Build the focused, read-only ProofGraph projection response (advisory).
 * Never approves or gates; surfaces claim states, freshness, and critical gaps.
 */
async function buildProofGraphProjectionResponse(
  state: SessionState,
  policy: FlowGuardPolicy,
  checkFields: Record<string, unknown>,
): Promise<string> {
  const now = new Date().toISOString();
  const structuralSurfaces = evaluateStructuralSurfaces();
  // Profile summaries for the reviewer projection come from the default report;
  // claim-binding verdicts come ONLY from per-attempt digest-verified reports.
  const mutationReport = await loadMutationReport(state.binding.worktree);
  const mutationSummaries = evaluateMutationProfiles(mutationReport);
  const mutationVerdicts = await resolveVerifiedMutationVerdicts(
    state.binding.worktree,
    state.mutationAttempts,
  );
  const proofGraph = summarizeProofGraph(state, now, {
    providerResults: [
      ...bindStructuralEvidence(state, structuralSurfaces, now),
      ...bindMutationEvidence(state, mutationVerdicts, now),
    ],
    surfaceDigests: surfaceDigestMap(structuralSurfaces),
    mutationSummaries,
  });
  const authorization = authorizedCriticalPlanClaimIds(planClaimAuthorityOf(state.plan));
  const riskAssessment = state.implementationRiskAssessment;
  const proofGraphGate = evaluateProofGraphGate({
    projection: proofGraph.projection,
    authorizedCriticalClaimIds: authorization.kind === 'authorized' ? authorization.claimIds : [],
    certificateValid: authorization.kind === 'authorized',
    ...(state.implementation ? { implementationDigest: state.implementation.digest } : {}),
    ...(riskAssessment !== undefined ? { riskAssessment } : {}),
    claimDiagnostics: proofGraph.claimDiagnostics,
  });
  const registrationConsistency = checkRegistrationConsistency();
  const configConsistency = checkConfigDefaultConsistency();
  return JSON.stringify(
    enrichWithWorkflowDirective(
      {
        phase: state.phase,
        sessionId: state.id,
        proofGraph,
        persistedProofGraph: summarizePersistedProofGraph(state),
        proofApprovals: buildProofApprovalProjection(state),
        proofGraphGate,
        registrationConsistency,
        configConsistency,
        ...checkFields,
      },
      state,
    ),
  );
}

/**
 * Resolve a focused projection response, or null if no projection flag is set.
 */
interface ResolveProjectionInput {
  readonly args: StatusArgs;
  readonly state: SessionState;
  readonly policy: FlowGuardPolicy;
  readonly sessDir: string;
  readonly presentation: PresentationRenderOptions;
}

async function buildFinishProjectionResponse(
  input: ResolveProjectionInput,
  checkFields: Record<string, unknown>,
): Promise<string> {
  const { state, policy, sessDir, presentation } = input;
  const reviewReport = await readReport(sessDir);
  const finishCard = buildFinishCard(state, policy, reviewReport);
  const finishPres = buildFinishPresentationProjection(state, finishCard);
  const finishDoc = buildFinishDocument(finishPres);
  return JSON.stringify(
    enrichWithWorkflowDirective(
      {
        phase: state.phase,
        sessionId: state.id,
        finish: finishCard,
        ...checkFields,
        presentation: { markdown: renderMarkdown(finishDoc, presentation) },
      },
      state,
    ),
  );
}
async function resolveProjection(input: ResolveProjectionInput): Promise<string | null> {
  const { args, state, policy, presentation } = input;
  const checkFields = buildCheckProjectionFields(state, policy);
  // /finish is the most comprehensive focused projection and is placed first so
  // its own template call is never shadowed by a stray additional flag. This
  // preserves the existing first-match dispatch semantics for all other flags.
  if (args.finish) {
    return await buildFinishProjectionResponse(input, checkFields);
  }
  if (args.whyBlocked) {
    const blocked = buildBlockedProjection(state, policy);
    const whyPres = buildWhyPresentationProjection(state, policy, blocked);
    const whyDoc = buildWhyDocument(whyPres);
    emitDetailRequested(state);
    return JSON.stringify(
      enrichWithWorkflowDirective(
        {
          phase: state.phase,
          sessionId: state.id,
          whyBlocked: blocked,
          ...checkFields,
          presentation: { markdown: renderMarkdown(whyDoc, presentation) },
        },
        state,
      ),
    );
  }
  if (args.evidence) {
    const evidenceDetail = buildEvidenceDetailProjection(state);
    return JSON.stringify(
      enrichWithWorkflowDirective(
        {
          phase: state.phase,
          sessionId: state.id,
          evidence: evidenceDetail,
          ...checkFields,
        },
        state,
      ),
    );
  }
  if (args.context) {
    const contextDetail = buildContextProjection(state);
    return JSON.stringify(
      enrichWithWorkflowDirective(
        {
          phase: state.phase,
          sessionId: state.id,
          context: contextDetail,
          ...checkFields,
        },
        state,
      ),
    );
  }
  if (args.readiness) {
    const readinessDetail = buildReadinessProjection(state, policy);
    return JSON.stringify(
      enrichWithWorkflowDirective(
        {
          phase: state.phase,
          sessionId: state.id,
          readiness: readinessDetail,
          ...checkFields,
        },
        state,
      ),
    );
  }
  if (args.proofGraph) {
    return await buildProofGraphProjectionResponse(state, policy, checkFields);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// flowguard_status — Read-Only State Check
// ═══════════════════════════════════════════════════════════════════════════════

export const status: ToolDefinition = {
  description:
    'Read the current FlowGuard session state. Returns phase, evidence summary, ' +
    'policy info, completeness matrix, and next action. ' +
    'Does NOT mutate state. Use /status to inspect session state or debug blockers. ' +
    'Use /continue for deterministic next-action routing (tells you which command to run next).',
  args: {
    whyBlocked: z
      .boolean()
      .optional()
      .describe('Return focused blocker surface from the state machine evaluator.'),
    evidence: z
      .boolean()
      .optional()
      .describe('Return per-slot evidence detail from the session completeness check.'),
    context: z.boolean().optional().describe('Return actor/policy/archive context projection.'),
    readiness: z.boolean().optional().describe('Return compact operational readiness projection.'),
    finish: z
      .boolean()
      .optional()
      .describe(
        'Return the read-only Finish Card: overall status, readiness, evidence, ' +
          'non-normative action guidance, and exit options. Never approves or mutates.',
      ),
    proofGraph: z
      .boolean()
      .optional()
      .describe(
        'Return the advisory ProofGraph summary: per-claim verification states, ' +
          'freshness, and critical gaps. Read-only; never approves or gates.',
      ),
  },
  async execute(_args, context) {
    try {
      const { wsDir } = await resolveWorkspacePaths(context);
      const presentation: PresentationRenderOptions = {
        glyphProfile: (await readConfig(wsDir)).presentation.opencode.glyphProfile,
      };
      const { state, policy, sessDir } = await withReadOnlySession(context);

      if (!state) {
        const noSessionDoc = buildNoSessionDocument();
        return JSON.stringify({
          phase: null,
          status: 'No FlowGuard session found.',
          discoveryHealth: null,
          discoveryDrift: null,
          agentInstruction: 'Run /start to bootstrap a session.',
          governanceMandates: {
            source: 'src/templates/mandates.ts',
            projection: 'none-without-canonical-session-state',
            mandatesVerbosity: 'explicit',
            renderFallbackIsPromptSafetyOnly: true,
            runtimeAllowRequiresCanonicalStatePolicyPhaseEvidence: true,
          },
          build: buildIdentityField(),
          presentation: { markdown: renderMarkdown(noSessionDoc, presentation) },
        });
      }

      const ev = evaluate(state, policy);
      const completeness = evaluateCompleteness(state);
      const args = _args as StatusArgs;

      // Resolve runtime readiness via toolchain probes — planner for profile IDs
      const runtimeCandidates = await resolveRuntimeWithProfileIds(state);

      const projection = await resolveProjection({
        args,
        state,
        policy,
        sessDir,
        presentation,
      });
      if (projection !== null) return projection;

      const { discovery, discoveryHealth } = await loadDiscoveryStatusContext(wsDir);
      const discoveryDrift = await buildDiscoveryDriftStatus({
        workspaceDir: wsDir,
        worktree: state.binding.worktree,
        fingerprint: state.binding.fingerprint,
      });
      return buildFullStatusResponse({
        state,
        policy,
        ev,
        completeness,
        discovery,
        discoveryHealth,
        discoveryDrift,
        presentation,
        runtimeCandidates,
      });
    } catch (err) {
      if (err instanceof ActorClaimError) {
        return formatBlocked(err.code);
      }
      return formatError(err);
    }
  },
};
