/**
 * @module integration/tools
 * @description Barrel export for FlowGuard tool definitions.
 *
 * Re-exports 12 tools from focused modules:
 * - helpers.ts        — shared interfaces, formatters, workspace/state/policy helpers
 * - hydrate.ts        — session bootstrap with discovery and profile resolution
 * - plan.ts           — plan submission and independent review loop
 * - implement.ts      — implementation recording and review loop
 * - architecture.ts   — ADR submission and review loop
 * - status-tool.ts    — read-only session state check
 * - decision-tool.ts  — human review verdict at user gates
 * - run-check-tool.ts — verification command execution with evidence
 * - simple-tools.ts   — ticket, review, abort, archive
 *
 * Barrel re-exports are resolved by the post-build ESM import fixer.
 *
 * @version v6
 */

import { status as rawStatus } from './status-tool.js';
import { decision as rawDecision } from './decision-tool.js';
import { run_check as rawRunCheck } from './run-check-tool.js';
import {
  ticket as rawTicket,
  review as rawReview,
  abort_session as rawAbortSession,
  archive as rawArchive,
} from './simple-tools.js';
import { hydrate as rawHydrate } from './hydrate.js';
import { plan as rawPlan } from './plan.js';
import { implement as rawImplement } from './implement.js';
import { architecture as rawArchitecture } from './architecture.js';
import { continue_cmd as rawContinue } from './continue-tool.js';
import type { ToolDefinition, ToolResult } from './helpers.js';

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

function attachFooterToString(output: string): string {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return output;
    }
    const record = parsed as Record<string, unknown>;
    if (!record.flowguardFooter) {
      record.flowguardFooter = buildFlowGuardFooter(record.phase);
    }
    return JSON.stringify(record);
  } catch {
    return `${output}\n[FlowGuard | Phase: unknown | Rule: stop after failed or blocked tool result | Recovery hint: flowguard_status after compaction]`;
  }
}

export function attachGovernanceFooter(result: ToolResult): ToolResult {
  if (typeof result === 'string') return attachFooterToString(result);
  return {
    ...result,
    output: attachFooterToString(result.output),
    metadata: {
      ...result.metadata,
      flowguardFooter: result.metadata?.flowguardFooter ?? buildFlowGuardFooter('unknown'),
    },
  };
}

function withGovernanceFooter(toolDef: ToolDefinition): ToolDefinition {
  return {
    ...toolDef,
    async execute(args, context) {
      return attachGovernanceFooter(await toolDef.execute(args, context));
    },
  };
}

// ── Focused tools ────────────────────────────────────────────────────────────
export const status = withGovernanceFooter(rawStatus);
export const decision = withGovernanceFooter(rawDecision);
export const run_check = withGovernanceFooter(rawRunCheck);

// ── Simple tools ─────────────────────────────────────────────────────────────
export const ticket = withGovernanceFooter(rawTicket);
export const review = withGovernanceFooter(rawReview);
export const abort_session = withGovernanceFooter(rawAbortSession);
export const archive = withGovernanceFooter(rawArchive);

// ── Complex tools ────────────────────────────────────────────────────────────
export const hydrate = withGovernanceFooter(rawHydrate);
export const plan = withGovernanceFooter(rawPlan);
export const implement = withGovernanceFooter(rawImplement);
export const architecture = withGovernanceFooter(rawArchitecture);
const continueTool = withGovernanceFooter(rawContinue);
export { continueTool as continue };
