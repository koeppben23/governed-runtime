/**
 * @module integration/tool-classification
 * @description Tool classification registry for FlowGuard.
 *
 * Distinguishes between:
 * - workflow tools: Route through machine/commands COMMAND_POLICY
 * - operational tools: Have their own guards, explicitly classified
 *
 * This registry enables targeted checks:
 * - Workflow tools MUST use COMMAND_POLICY
 * - Operational tools MUST have explicit classification and guard tests
 * - No tool may exist outside classification
 *
 * @version v2
 */

import { Command } from '../machine/commands.js';

/**
 * Tool classification types.
 */
export type ToolClassification = 'workflow' | 'operational';

/**
 * Tool classification registry.
 * Every tool MUST be listed here.
 * Uses canonical TOOL_FLOWGUARD_* names from tool-names.ts
 */
import {
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_VALIDATE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
} from './tool-names.js';

export const TOOL_CLASSIFICATION = {
  // Workflow tools (must use COMMAND_POLICY from machine/commands)
  [TOOL_FLOWGUARD_HYDRATE]: 'workflow',
  [TOOL_FLOWGUARD_TICKET]: 'workflow',
  [TOOL_FLOWGUARD_PLAN]: 'workflow',
  [TOOL_FLOWGUARD_VALIDATE]: 'workflow',
  [TOOL_FLOWGUARD_IMPLEMENT]: 'workflow',
  [TOOL_FLOWGUARD_DECISION]: 'workflow',
  [TOOL_FLOWGUARD_REVIEW]: 'workflow',
  [TOOL_FLOWGUARD_CONTINUE]: 'workflow',
  [TOOL_FLOWGUARD_ARCHITECTURE]: 'workflow',
  [TOOL_FLOWGUARD_ABORT]: 'workflow',

  // Operational tools (explicitly classified, own guards)
  [TOOL_FLOWGUARD_STATUS]: 'operational',
  [TOOL_FLOWGUARD_ARCHIVE]: 'operational',
} as const;

type OperationalToolName = typeof TOOL_FLOWGUARD_STATUS | typeof TOOL_FLOWGUARD_ARCHIVE;
type WorkflowToolName = Exclude<keyof typeof TOOL_CLASSIFICATION, OperationalToolName>;

/**
 * Workflow tool → Command mapping.
 * Every workflow tool MUST have a corresponding Command.
 */
export const WORKFLOW_TOOL_TO_COMMAND = {
  [TOOL_FLOWGUARD_HYDRATE]: Command.HYDRATE,
  [TOOL_FLOWGUARD_TICKET]: Command.TICKET,
  [TOOL_FLOWGUARD_PLAN]: Command.PLAN,
  [TOOL_FLOWGUARD_VALIDATE]: Command.VALIDATE,
  [TOOL_FLOWGUARD_IMPLEMENT]: Command.IMPLEMENT,
  [TOOL_FLOWGUARD_DECISION]: Command.REVIEW_DECISION,
  [TOOL_FLOWGUARD_REVIEW]: Command.REVIEW,
  [TOOL_FLOWGUARD_CONTINUE]: Command.CONTINUE,
  [TOOL_FLOWGUARD_ARCHITECTURE]: Command.ARCHITECTURE,
  [TOOL_FLOWGUARD_ABORT]: Command.ABORT,
} satisfies Record<WorkflowToolName, Command>; // Checks all workflow tools are mapped

/**
 * True when the tool routes through COMMAND_POLICY.
 */
export function isWorkflowTool(toolName: string): boolean {
  try {
    return getToolClassification(toolName) === 'workflow';
  } catch {
    return false;
  }
}

/**
 * True when the tool has explicit operational guards outside COMMAND_POLICY.
 */
export function isOperationalTool(toolName: string): boolean {
  try {
    return getToolClassification(toolName) === 'operational';
  } catch {
    return false;
  }
}

/**
 * Get tool classification.
 * Throws if tool is not classified.
 */
export function getToolClassification(toolName: string): ToolClassification {
  const classification = TOOL_CLASSIFICATION[toolName as keyof typeof TOOL_CLASSIFICATION];
  if (!classification) {
    throw new Error(`Unclassified tool: ${toolName}. Add to TOOL_CLASSIFICATION registry.`);
  }
  return classification;
}

/**
 * List all classified tools.
 */
export function listClassifiedTools(): Array<{ tool: string; classification: ToolClassification }> {
  return Object.entries(TOOL_CLASSIFICATION).map(([tool, classification]) => ({
    tool,
    classification: classification as ToolClassification,
  }));
}
