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

export function extractJsonFromTextWithMethod(text: string): {
  value: Record<string, unknown>;
  extractionMethod: 'direct_json' | 'json_fence' | 'outermost_braces';
} | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Strategy 1: direct parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed, extractionMethod: 'direct_json' };
    }
  } catch {
    // not pure JSON — try next strategy
  }

  // Strategy 2: strip markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]!.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { value: parsed, extractionMethod: 'json_fence' };
      }
    } catch {
      // fence content not valid JSON
    }
  }

  // Strategy 3: outermost brace extraction
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
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
    if (lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { value: parsed, extractionMethod: 'outermost_braces' };
        }
      } catch {
        // brace content not valid JSON
      }
    }
  }

  return null;
}
