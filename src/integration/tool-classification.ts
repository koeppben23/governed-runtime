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
 * @version v1
 */

/**
 * Tool classification types.
 */
export type ToolClassification = 'workflow' | 'operational';

/**
 * Tool classification registry.
 * Every tool MUST be listed here.
 */
export const TOOL_CLASSIFICATION = {
  // Workflow tools (must use COMMAND_POLICY from machine/commands)
  hydrate: 'workflow',
  ticket: 'workflow',
  plan: 'workflow',
  continue: 'workflow',
  validate: 'workflow',
  implement: 'workflow',
  'review-decision': 'workflow',
  review: 'workflow',
  architecture: 'workflow',
  abort: 'workflow',

  // Operational tools (explicitly classified, own guards)
  status: 'operational',
  archive: 'operational',
  doctor: 'operational',
  install: 'operational',
} as const;

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
 * Check if a tool is a workflow tool.
 */
export function isWorkflowTool(toolName: string): boolean {
  try {
    return getToolClassification(toolName) === 'workflow';
  } catch {
    return false;
  }
}

/**
 * Check if a tool is an operational tool.
 */
export function isOperationalTool(toolName: string): boolean {
  try {
    return getToolClassification(toolName) === 'operational';
  } catch {
    return false;
  }
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
