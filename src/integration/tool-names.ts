/**
 * @module integration/tool-names
 * @description Canonical FlowGuard tool name constants.
 *
 * Single source of truth for all FlowGuard tool names and agent identifiers.
 * Every module that compares or routes on tool names MUST import from here.
 *
 * REVIEWER_SUBAGENT_TYPE is re-exported from shared/flowguard-identifiers.ts
 * (neutral module, zero dependencies, importable by any layer).
 *
 * @version v1
 */

export const TOOL_FLOWGUARD_STATUS = 'flowguard_status';
export const TOOL_FLOWGUARD_HYDRATE = 'flowguard_hydrate';
export const TOOL_FLOWGUARD_TICKET = 'flowguard_ticket';
export const TOOL_FLOWGUARD_PLAN = 'flowguard_plan';
export const TOOL_FLOWGUARD_DECISION = 'flowguard_decision';
export const TOOL_FLOWGUARD_IMPLEMENT = 'flowguard_implement';
/**
 * Verdict tool for the implementation review loop (issue #565).
 *
 * Split out of the former multi-mode `flowguard_implement` so that the
 * record-evidence call and the submit-verdict call are SEPARATE single-purpose
 * tools. `flowguard_implement` now only records evidence (no verdict args);
 * `flowguard_review_implementation` only submits the reviewer's verdict. This
 * makes the previously-possible invalid state — sending a `reviewVerdict` on an
 * evidence-record call — unrepresentable at the tool surface.
 */
export const TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION = 'flowguard_review_implementation';
export const TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE =
  'flowguard_resolve_implementation_challenge';
export const TOOL_FLOWGUARD_RUN_CHECK = 'flowguard_run_check';
export const TOOL_FLOWGUARD_REVIEW = 'flowguard_review';
export const TOOL_FLOWGUARD_CONTINUE = 'flowguard_continue';
export const TOOL_FLOWGUARD_ARCHITECTURE = 'flowguard_architecture';
export const TOOL_FLOWGUARD_ABORT = 'flowguard_abort_session';
export const TOOL_FLOWGUARD_ARCHIVE = 'flowguard_archive';
export const TOOL_FLOWGUARD_HELP = 'flowguard_help';
export const TOOL_FLOWGUARD_DECLARE_CONTRACT = 'flowguard_declare_contract';
export const TOOL_FLOWGUARD_RECORD_MUTATION_EVIDENCE = 'flowguard_record_mutation_evidence';

/** The complete set of canonical FlowGuard tool names (single source of truth). */
export const ALL_FLOWGUARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
  TOOL_FLOWGUARD_RUN_CHECK,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_DECLARE_CONTRACT,
  TOOL_FLOWGUARD_RECORD_MUTATION_EVIDENCE,
]);

export { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';

const FLOWGUARD_VERDICT_TOOLS: ReadonlySet<string> = new Set([
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_REVIEW,
]);

export function isFlowGuardVerdictTool(toolName: string): boolean {
  return FLOWGUARD_VERDICT_TOOLS.has(toolName);
}
