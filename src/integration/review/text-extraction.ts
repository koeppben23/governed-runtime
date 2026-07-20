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
 * Additionally exposes a string-aware multi-object scanner
 * (`scanTopLevelJsonObjects` / `extractLastMatchingJsonObject`) used by the
 * host-task evidence path to recover a trailing ReviewFindings object from a
 * response that also contains prose and quoted artifact content.
 *
 * @version v2
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

/**
 * Scan text for every top-level, brace-balanced `{...}` block and return each
 * that parses to a JSON object. String-aware: braces inside string literals
 * (and escaped quotes) do not affect nesting depth, so quoted artifact content
 * (ADR/diff bodies, code snippets containing `{`) cannot corrupt the scan.
 *
 * Order is preserved (document order). Callers that expect a trailing verdict
 * object should select the LAST match satisfying their predicate — reviewer
 * output conventionally emits reasoning/quoted content first and the
 * ReviewFindings object last.
 */
export function scanTopLevelJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  // Linear right-to-left matching of balanced `{...}` spans.
  //
  // A single left-to-right depth counter cannot both (a) skip unbalanced leading
  // `{` (a quoted diff with many `{`) and (b) stay O(n): re-trying each `{` as a
  // fresh start is O(n^2). Instead we do ONE right-to-left pass, pairing every
  // `}` with the nearest still-unmatched `{` via a stack of `{` positions. Each
  // matched pair is a balanced span; we parse it and keep object candidates.
  //
  // String handling: JSON strings may contain `{`/`}`. We first compute, in one
  // left-to-right pass, which positions are inside a string literal so brace
  // matching ignores them. String tracking only runs at brace-nesting depth > 0
  // so a stray `"` in prose cannot swallow following braces.
  const inString = computeStringMask(text);

  const openStack: number[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < text.length; i++) {
    if (inString[i]) continue;
    const ch = text[i];
    if (ch === '{') {
      openStack.push(i);
    } else if (ch === '}') {
      const start = openStack.pop();
      if (start !== undefined) spans.push({ start, end: i });
    }
  }

  // spans are inner-to-outer within a nest and right-to-left across nests. Sort
  // by start ascending, then keep only top-level spans (not contained in another
  // kept span) so nested objects are not emitted as separate candidates.
  spans.sort((a, b) => a.start - b.start);
  let lastEnd = -1;
  for (const span of spans) {
    if (span.start <= lastEnd) continue; // contained in an already-kept span
    const slice = text.slice(span.start, span.end + 1);
    try {
      const parsed = JSON.parse(slice) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* balanced braces but not valid JSON — skip */
    }
    lastEnd = span.end;
  }
  return objects;
}

/**
 * One-pass boolean mask marking characters that lie inside a JSON string literal.
 * String tracking only begins at brace-nesting depth > 0, so a lone `"` in prose
 * (outside any object candidate) does not start a string and cannot swallow
 * subsequent braces. Escapes (`\"`, `\\`) are honoured.
 */
function computeStringMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      mask[i] = true;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) {
        inString = true;
        mask[i] = true;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && depth > 0) depth--;
  }
  return mask;
}

/**
 * From a text response, return the LAST top-level JSON object that satisfies the
 * predicate, or null. Used by the host-task evidence path to recover the
 * reviewer's ReviewFindings object even when prose or quoted artifact content
 * (with braces, and with nested objects before `overallVerdict`) precedes it.
 */
export function extractLastMatchingJsonObject(
  text: string,
  predicate: (obj: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const objects = scanTopLevelJsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    if (predicate(objects[i]!)) return objects[i]!;
  }
  return null;
}
