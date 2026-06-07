/**
 * @module integration/review-text-extraction
 * @description Multi-strategy JSON extraction from unstructured text responses.
 *
 * Extracted from review-orchestrator.ts (FG-REL-038) for single-responsibility.
 * Pure utility functions with zero dependencies on SDK, state, or enforcement.
 *
 * Strategies (tried in order):
 * 1. Direct JSON.parse (response is pure JSON)
 * 2. Strip markdown code fences and parse
 * 3. Extract outermost brace-delimited block and parse
 *
 * @version v1
 */

/**
 * Extract JSON from unstructured text response.
 *
 * Belt-and-suspenders fallback when info.structured_output is absent or the
 * provider does not support the format field.
 *
 * Returns null if no valid JSON object can be extracted.
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  return extractJsonFromTextWithMethod(text)?.value ?? null;
}

function tryDirectParse(
  trimmed: string,
): { value: Record<string, unknown>; extractionMethod: 'direct_json' } | null {
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return { value: parsed, extractionMethod: 'direct_json' };
  } catch {
    /* not pure JSON */
  }
  return null;
}

function tryFenceParse(
  trimmed: string,
): { value: Record<string, unknown>; extractionMethod: 'json_fence' } | null {
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (!fenceMatch) return null;
  try {
    const parsed = JSON.parse(fenceMatch[1]!.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return { value: parsed, extractionMethod: 'json_fence' };
  } catch {
    /* invalid */
  }
  return null;
}

function tryBraceParse(
  trimmed: string,
): { value: Record<string, unknown>; extractionMethod: 'outermost_braces' } | null {
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace < 0) return null;
  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }
  if (lastBrace <= firstBrace) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return { value: parsed, extractionMethod: 'outermost_braces' };
  } catch {
    /* invalid */
  }
  return null;
}

export function extractJsonFromTextWithMethod(text: string): {
  value: Record<string, unknown>;
  extractionMethod: 'direct_json' | 'json_fence' | 'outermost_braces';
} | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return tryDirectParse(trimmed) ?? tryFenceParse(trimmed) ?? tryBraceParse(trimmed);
}
