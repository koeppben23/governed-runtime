/**
 * @module integration/review-enforcement-extraction
 * @description Pure parsing and extraction helpers for review enforcement.
 *
 * Extracted from review-enforcement.ts (FG-REL-038) for single-responsibility.
 * All functions are pure (no state mutation) and operate on raw strings/objects.
 *
 * Responsibilities:
 * - Content metadata extraction from FlowGuard tool `next` field
 * - Captured findings extraction from Task tool output
 * - Session ID resolution and injection
 * - JSON block extraction (brace-balanced parser)
 * - Prompt keyword-value matching (L3 enforcement support)
 *
 * @version v1
 */

import type { CapturedFindings } from './review-enforcement-types.js';

// ─── Content Metadata Extraction ─────────────────────────────────────────────

/**
 * Extract content metadata (iteration, planVersion) from the
 * INDEPENDENT_REVIEW_REQUIRED message string.
 *
 * @returns ContentMeta or null if iteration cannot be extracted
 */
export function extractContentMeta(
  nextField: string,
): { expectedIteration: number; expectedPlanVersion: number | null } | null {
  const iterMatch = nextField.match(/iteration[=:\s]+(\d+)/i);
  if (!iterMatch) return null;

  const versionMatch = nextField.match(/planVersion[=:\s]+(\d+)/i);

  return {
    expectedIteration: parseInt(iterMatch[1]!, 10),
    expectedPlanVersion: versionMatch ? parseInt(versionMatch[1]!, 10) : null,
  };
}

// ─── Captured Findings Extraction ────────────────────────────────────────────

/**
 * Extract key fields from the actual subagent response for integrity checking.
 *
 * @returns CapturedFindings or null if extraction fails
 */
export function extractCapturedFindings(taskResult: string): CapturedFindings | null {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(taskResult) as unknown;
    const result = extractFindingsFromObject(parsed);
    if (result) return result;
  } catch {
    // Not clean JSON — continue to regex extraction
  }

  // Try to find a JSON block containing overallVerdict in the response
  const jsonMatch = taskResult.match(/\{[^{}]*"overallVerdict"\s*:\s*"[^"]+"/);
  if (jsonMatch) {
    const startIdx = taskResult.indexOf(jsonMatch[0]);
    const candidate = extractJsonBlock(taskResult, startIdx);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const result = extractFindingsFromObject(parsed);
        if (result) return result;
      } catch {
        // Parse failed — fall through
      }
    }
  }

  return null;
}

// ─── Prompt Keyword-Value Matching ───────────────────────────────────────────

/**
 * Check whether a reviewer prompt contains a specific numeric value
 * associated with a keyword (e.g. "iteration", "version").
 *
 * Matching rules:
 * - Case-insensitive keyword match.
 * - Up to 30 non-digit characters between keyword and number.
 * - Word-boundary at suffix prevents partial-number matches.
 */
export function promptContainsValue(prompt: string, keyword: string, expected: number): boolean {
  const pattern = new RegExp(`${keyword}[^\\d]{0,30}${expected}\\b`, 'i');
  return pattern.test(prompt);
}

// ─── Session ID Resolution & Injection ───────────────────────────────────────

/**
 * Extract the subagent session ID from hook metadata.
 *
 * Tier 1 (authoritative): checks common field names sessionID, sessionId, id.
 */
export function resolveSessionIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | null {
  if (!metadata) return null;
  if (typeof metadata.sessionID === 'string' && metadata.sessionID) return metadata.sessionID;
  if (typeof metadata.sessionId === 'string' && metadata.sessionId) return metadata.sessionId;
  if (typeof metadata.id === 'string' && metadata.id) return metadata.id;
  return null;
}

/**
 * Inject the authoritative child session ID into ReviewFindings JSON.
 *
 * Handles three output formats:
 * 1. Clean JSON: full output is valid JSON
 * 2. Embedded JSON: JSON block with `"reviewedBy"` marker in mixed text
 * 3. Non-JSON: returns original text unchanged
 */
export function injectSessionIdIntoOutput(output: string, sessionId: string): string {
  // Path 1: clean JSON parse
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      injectSessionIdIntoObject(parsed, sessionId);
      return JSON.stringify(parsed);
    }
  } catch {
    // Not clean JSON — fall through to embedded extraction
  }

  // Path 2: find embedded JSON block containing "reviewedBy"
  const markerIdx = output.indexOf('"reviewedBy"');
  if (markerIdx < 0) return output;

  const startIdx = output.lastIndexOf('{', markerIdx);
  if (startIdx < 0) return output;

  const block = extractJsonBlock(output, startIdx);
  if (!block) return output;

  try {
    const parsed = JSON.parse(block) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      injectSessionIdIntoObject(parsed, sessionId);
      return (
        output.slice(0, startIdx) + JSON.stringify(parsed) + output.slice(startIdx + block.length)
      );
    }
  } catch {
    // Unparseable block — return original
  }

  return output;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Inject sessionId into the reviewedBy field of a parsed ReviewFindings object.
 * Mutates the object in place.
 */
function injectSessionIdIntoObject(obj: Record<string, unknown>, sessionId: string): void {
  const reviewedBy = obj.reviewedBy;
  if (typeof reviewedBy === 'object' && reviewedBy !== null && !Array.isArray(reviewedBy)) {
    (reviewedBy as Record<string, unknown>).sessionId = sessionId;
  } else {
    obj.reviewedBy = { sessionId };
  }
}

/**
 * Extract the subagent session ID from the Task tool response (Tier 2).
 * Returns null if extraction fails (no fallback — strict for Level 2).
 */
export function extractSubagentSessionId(taskResult: string): string | null {
  try {
    const parsed = JSON.parse(taskResult) as Record<string, unknown>;
    const direct = extractSessionIdFromObject(parsed);
    if (direct) return direct;
  } catch {
    // Not clean JSON — try to find JSON in the text
  }

  let searchFrom = 0;
  while (searchFrom < taskResult.length) {
    const markerIdx = taskResult.indexOf('"reviewedBy"', searchFrom);
    if (markerIdx < 0) break;

    const startIdx = taskResult.lastIndexOf('{', markerIdx);
    if (startIdx < 0) break;

    const candidate = extractJsonBlock(taskResult, startIdx);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        const extracted = extractSessionIdFromObject(parsed);
        if (extracted) return extracted;
      } catch {
        // Continue scanning for another candidate
      }
      searchFrom = Math.max(startIdx + candidate.length, markerIdx + '"reviewedBy"'.length);
      continue;
    }

    searchFrom = markerIdx + '"reviewedBy"'.length;
  }

  return null;
}

function extractSessionIdFromObject(obj: Record<string, unknown>): string | null {
  const reviewedBy = obj.reviewedBy as Record<string, unknown> | undefined;
  if (typeof reviewedBy?.sessionId === 'string') {
    return reviewedBy.sessionId;
  }
  if (typeof obj.sessionId === 'string') {
    return obj.sessionId;
  }
  return null;
}

/**
 * Extract CapturedFindings fields from a parsed object.
 * Returns null if the object doesn't contain a valid overallVerdict.
 */
function extractFindingsFromObject(obj: unknown): CapturedFindings | null {
  if (!obj || typeof obj !== 'object') return null;

  const record = obj as Record<string, unknown>;
  const overallVerdict = typeof record.overallVerdict === 'string' ? record.overallVerdict : null;
  if (!overallVerdict) return null;

  const blockingIssues = Array.isArray(record.blockingIssues) ? record.blockingIssues : [];
  const reviewedBy = record.reviewedBy as Record<string, unknown> | undefined;
  const sessionId = typeof reviewedBy?.sessionId === 'string' ? reviewedBy.sessionId : null;

  const captured: CapturedFindings = {
    overallVerdict,
    blockingIssuesCount: blockingIssues.length,
    sessionId,
  };
  Object.defineProperty(captured, 'rawFindings', {
    value: record,
    enumerable: false,
  });
  return captured;
}

/**
 * Extract a complete JSON block starting from a given index.
 * Counts braces to find the matching closing brace, respecting string escaping.
 */
export function extractJsonBlock(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}
