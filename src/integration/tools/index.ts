/**
 * @module integration/tools
 * @description Barrel export for FlowGuard tool definitions.
 *
 * Re-exports 20 tools from focused modules:
 * - helpers.ts        — shared interfaces, formatters, workspace/state/policy helpers
 * - hydrate.ts        — session bootstrap with discovery and profile resolution
 * - plan.ts           — plan submission and independent review loop
 * - implement.ts      — implementation recording (flowguard_implement) and
 *                       review verdict (flowguard_review_implementation) — split
 *                       into single-purpose tools (issue #565)
 * - architecture.ts   — ADR submission and review loop
 * - status-tool.ts    — read-only session state check
 * - decision-tool.ts  — human review verdict at user gates
 * - run-check-tool.ts — verification command execution with evidence
 * - simple/          — ticket, abort, archive, export, help, continue command contexts
 * - review-tool/     — peer review command transport
 *
 * Barrel re-exports are resolved by the post-build ESM import fixer.
 *
 * @version v6
 */

import { status as rawStatus } from './status/status-tool.js';
import { decision as rawDecision } from './decision/decision-tool.js';
import { run_check as rawRunCheck } from './validation/run-check-tool.js';
import { ticket as rawTicket } from './simple/ticket-tool.js';
import { review as rawReview } from './review-tool/index.js';
import { abort_session as rawAbortSession } from './simple/abort-tool.js';
import { archive as rawArchive } from './simple/archive-tool.js';
import { hydrate as rawHydrate } from './hydrate/hydrate.js';
import { plan as rawPlan } from './plan/plan.js';
import { implement as rawImplement } from './implementation/implement.js';
import { review_implementation as rawReviewImplementation } from './implementation/implement.js';
import { architecture as rawArchitecture } from './architecture/architecture.js';
import { continue_cmd as rawContinue } from './simple/continue-tool.js';
import { help as rawHelp } from './simple/help-tool.js';
import { resolve_implementation_challenge as rawResolveImplementationChallenge } from './challenge/challenge-resolution.js';
import { declare_contract as rawDeclareContract } from './contract/declare-contract.js';
import { record_mutation_evidence as rawRecordMutationEvidence } from './mutation/record-mutation-evidence.js';
import { reconcile_mutation_episode as rawReconcileMutationEpisode } from './mutation/reconcile-mutation-episode.js';
import { observe_repository as rawObserveRepository } from './observe/observe-repository.js';
import { export_session as rawExportSession } from './simple/export-tool.js';
import type { ToolDefinition, ToolResult } from './helpers.js';
import { readConfig } from '../../adapters/persistence-config.js';
import type { GlyphProfile } from '../../presentation/glyph-profile.js';
import { emitTelemetryEvent } from '../../telemetry/human-projection/emitter.js';
import type { ActionIntent } from '../../shared/presentation-vocabulary.js';
import { renderMarkdown } from '../../presentation/markdown.js';
import type { PresentationDocument } from '../../presentation/model.js';

function buildFlowGuardFooter(phase: unknown): Record<string, unknown> {
  return {
    source: 'flowguard-tool-output-wrapper',
    authority: 'diagnostic-only',
    phase: typeof phase === 'string' ? phase : 'unknown',
    reminder:
      'Treat failed, blocked, malformed, or nonconforming FlowGuard tool results as stop conditions.',
    compactionRecoveryHint:
      'Call flowguard_status to restore phase-relevant governance context after compaction.',
    renderFallbackIsPromptSafetyOnly: true,
    runtimeAllowRequiresCanonicalStatePolicyPhaseEvidence: true,
  };
}

function attachFooterToString(output: string, glyphProfile?: GlyphProfile): string {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return output;
    }
    const record = parsed as Record<string, unknown>;
    attachPresentationToBlockedResult(record, glyphProfile);
    if (!record.flowguardFooter) {
      record.flowguardFooter = buildFlowGuardFooter(record.phase);
    }
    return JSON.stringify(record);
  } catch {
    // Markdown is a public presentation surface. Do not append diagnostics that
    // invalidate the command template's verbatim-rendering contract.
    return output;
  }
}

/**
 * Add the smallest shared-renderer presentation for legacy blocked JSON at the
 * OpenCode tool boundary. Other host protocols retain their raw payloads.
 */
function attachPresentationToBlockedResult(
  record: Record<string, unknown>,
  glyphProfile?: GlyphProfile,
): void {
  if (
    record.error !== true ||
    'presentation' in record ||
    typeof record.code !== 'string' ||
    typeof record.message !== 'string'
  ) {
    return;
  }

  const document: PresentationDocument = {
    kind: 'compact_card',
    density: 'compact',
    form: 'blocked',
    sections: [
      {
        kind: 'blocker',
        code: record.code,
        text: record.message,
        ...(typeof record.recovery === 'string' && record.recovery.length > 0
          ? { recovery: record.recovery }
          : {}),
      },
    ],
    conclusion: {
      kind: 'terminal',
      message:
        typeof record.recovery === 'string' && record.recovery.length > 0
          ? record.recovery
          : record.message,
    },
  };
  record.presentation = {
    markdown: renderMarkdown(document, {
      ...(glyphProfile !== undefined ? { glyphProfile } : {}),
    }),
  };
}

function needsPresentationProfile(result: ToolResult): boolean {
  const output = typeof result === 'string' ? result : result.output;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return (
      record.error === true &&
      !('presentation' in record) &&
      typeof record.code === 'string' &&
      typeof record.message === 'string'
    );
  } catch {
    return false;
  }
}

export function attachGovernanceFooter(
  result: ToolResult,
  glyphProfile?: GlyphProfile,
): ToolResult {
  if (typeof result === 'string') return attachFooterToString(result, glyphProfile);
  return {
    ...result,
    output: attachFooterToString(result.output, glyphProfile),
    metadata: {
      ...result.metadata,
      flowguardFooter: result.metadata?.flowguardFooter ?? buildFlowGuardFooter('unknown'),
    },
  };
}

function withGovernanceFooter(
  toolDef: ToolDefinition,
  telemetry?: { intent?: ActionIntent },
): ToolDefinition {
  const intent = telemetry?.intent;
  return {
    ...toolDef,
    async execute(args, context) {
      let disposition: 'entered' | 'blocked' | 'failed' = 'entered';
      try {
        const result = await toolDef.execute(args, context);
        disposition = resultDisposition(result);
        let glyphProfile: GlyphProfile | undefined;
        if (needsPresentationProfile(result)) {
          try {
            glyphProfile = (await readConfig(context.worktree || context.directory)).presentation
              .opencode.glyphProfile;
          } catch {
            // Presentation must not replace canonical result when config loading fails.
          }
        }
        const finalResult = attachGovernanceFooter(result, glyphProfile);
        emitActionInvoked(disposition, intent, context);
        return finalResult;
      } catch (err) {
        emitActionInvoked('failed', intent, context);
        throw err;
      }
    },
  };
}

function emitActionInvoked(
  disposition: 'entered' | 'blocked' | 'failed',
  intent: ActionIntent | undefined,
  context: { worktree?: string; sessionID?: string },
): void {
  emitTelemetryEvent(
    { event: 'action_invoked', disposition, ...(intent ? { intent } : {}) },
    context.sessionID,
    undefined,
  );
}

function resultDisposition(result: ToolResult): 'entered' | 'blocked' | 'failed' {
  const output = typeof result === 'string' ? result : result.output;
  if (typeof output === 'string' && output.startsWith('{')) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && parsed.error === true) return 'blocked';
    } catch {
      /* not valid JSON — treat as entered */
    }
  }
  return 'entered';
}

// ── Focused tools ────────────────────────────────────────────────────────────
export const status = withGovernanceFooter(rawStatus, { intent: 'inspect_status' });
export const decision = withGovernanceFooter(rawDecision);
export const run_check = withGovernanceFooter(rawRunCheck, { intent: 'run_validation' });

// ── Simple tools ─────────────────────────────────────────────────────────────
export const ticket = withGovernanceFooter(rawTicket);
export const review = withGovernanceFooter(rawReview, { intent: 'rerun_review' });
export const abort_session = withGovernanceFooter(rawAbortSession);
export const archive = withGovernanceFooter(rawArchive, { intent: 'export_result' });
const exportTool = withGovernanceFooter(rawExportSession, { intent: 'export_result' });
export { exportTool as export };
export const help = withGovernanceFooter(rawHelp);

// ── Complex tools ────────────────────────────────────────────────────────────
export const hydrate = withGovernanceFooter(rawHydrate, { intent: 'refresh_repository' });
export const plan = withGovernanceFooter(rawPlan);
export const implement = withGovernanceFooter(rawImplement);
export const review_implementation = withGovernanceFooter(rawReviewImplementation);
export const resolve_implementation_challenge = withGovernanceFooter(
  rawResolveImplementationChallenge,
);
export const declare_contract = withGovernanceFooter(rawDeclareContract);
export const record_mutation_evidence = withGovernanceFooter(rawRecordMutationEvidence);
export const reconcile_mutation_episode = withGovernanceFooter(rawReconcileMutationEpisode);
// The sanctioned reviewer observation capability — never wrapped in the
// governance footer: its output is the deterministic observed-bytes payload
// whose exact bytes the parent replay hashes to prove delivery.
export const observe_repository = rawObserveRepository;
export const architecture = withGovernanceFooter(rawArchitecture);
const continueTool = withGovernanceFooter(rawContinue);
export { continueTool as continue };
