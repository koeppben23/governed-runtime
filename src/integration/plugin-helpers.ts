/**
 * @module integration/plugin-helpers
 * @description Pure utility functions extracted from plugin.ts.
 *
 * Stateless functions with no closure dependencies. Unit-testable without mock setup.
 *
 * @version v1
 */

/**
 * Parse tool output JSON with fallback for NextAction footer lines.
 *
 * The LLM output often contains a JSON block followed by free text
 * (such as a "Next action:" line or explanatory text). This function
 * first attempts to parse the full string as JSON, and if that fails,
 * tries parsing only the first line.
 *
 * @param rawOutput - The raw tool output, typically a JSON string
 * @returns Parsed object or null if parsing fails completely
 */
export function parseToolResult(rawOutput: unknown): Record<string, unknown> | null {
  try {
    const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
    return JSON.parse(resultStr);
  } catch {
    try {
      const resultStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
      const firstLine = resultStr.split('\n')[0] ?? '';
      if (!firstLine.trim()) return null;
      return JSON.parse(firstLine);
    } catch {
      return null;
    }
  }
}

/**
 * Build a strictly blocked error output in the format OpenCode expects.
 *
 * Used when review orchestration fails in strict mode — the output
 * is injected into the tool response to signal the failure to the agent.
 *
 * @param code - Error/reason code (e.g. 'SUBAGENT_MANDATE_MISMATCH')
 * @param detail - Key-value detail map for the error payload
 * @returns JSON string of the blocked output object
 */
export function strictBlockedOutput(code: string, detail: Record<string, string>): string {
  return JSON.stringify({
    error: true,
    code,
    message: `Blocked: ${code}`,
    detail,
    recovery: [],
  });
}
