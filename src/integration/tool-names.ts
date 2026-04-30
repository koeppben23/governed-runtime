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
export const TOOL_FLOWGUARD_VALIDATE = 'flowguard_validate';
export const TOOL_FLOWGUARD_REVIEW = 'flowguard_review';
export const TOOL_FLOWGUARD_ARCHITECTURE = 'flowguard_architecture';
export const TOOL_FLOWGUARD_ABORT = 'flowguard_abort_session';
export const TOOL_FLOWGUARD_ARCHIVE = 'flowguard_archive';

export { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
