/**
 * @module integration/tools/review-tool/review-input
 * @description Review content-input helpers: reference construction and the
 *              canonical source-completeness validation for /review arguments.
 *
 * Extracted from obligation.ts along the input boundary so obligation creation
 * and obligation validation can both consume them without a module cycle.
 *
 * @version v1
 */

import type { ReviewReferenceInput } from '../../../rails/review.js';
import { formatBlocked } from '../helpers.js';

// ─── Input helpers ───────────────────────────────────────────────────────────
export function buildReviewReferenceInput(args: {
  inputOrigin?: ReviewReferenceInput['inputOrigin'];
  references?: ReviewReferenceInput['references'];
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
  targetPaths?: readonly string[];
}): ReviewReferenceInput | undefined {
  const hasContent =
    args.inputOrigin || args.references || args.text || args.prNumber || args.branch || args.url;
  if (!hasContent) return undefined;
  return {
    inputOrigin: args.inputOrigin,
    references: args.references,
    text: args.text,
    prNumber: args.prNumber,
    branch: args.branch,
    url: args.url,
    targetPaths: args.targetPaths,
  };
}

export function hasReviewContentInput(args: {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): boolean {
  return hasConcreteContentField(args);
}

// ─── Canonical Source Validation ──────────────────────────────────────────────

/**
 * Result of canonical review-content source validation.
 *
 * This is the single authority that decides whether a `/review` call carries a
 * concrete content source.  It replaces the split between
 * `buildReviewReferenceInput` (which considers `inputOrigin` + `references`)
 * and `hasReviewContentInput` (which does not), so a declaration of intent
 * (`inputOrigin=branch`) that lacks the corresponding content field (`branch`)
 * is never silently treated as „no content“.
 */
export type ReviewContentSourceResult =
  | { readonly kind: 'valid' }
  | { readonly kind: 'none' }
  | { readonly kind: 'incomplete'; readonly blockCode: string; readonly blockMessage: string };

/**
 * Validate that a content-aware `/review` call carries at least one concrete
 * content source when `inputOrigin` or `references` are declared.
 *
 * `inputOrigin` and `references` are provenance metadata — they do **not**
 * load content by themselves.  Ungated metadata combined with no concrete
 * field (branch, text, prNumber, url) is an incomplete source and must be
 * blocked rather than treated as a content-free review.
 *
 * Calls with concrete content fields but no provenance metadata
 * (inputOrigin/references absent) are treated as implicit content-aware
 * reviews: the content is present, it just was not declared with origin
 * metadata.
 */
export function validateReviewContentSource(args: {
  inputOrigin?: string;
  references?: unknown;
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): ReviewContentSourceResult {
  if (hasConcreteContentField(args)) return { kind: 'valid' };

  const declared = hasDeclaredContentField(args);
  const signal = hasImplicitContentSignal(args);

  // Neither a content field nor provenance metadata — genuine content-free review.
  if (!declared && !signal) return { kind: 'none' };

  const labelParts = [
    signal && args.inputOrigin ? `inputOrigin=${args.inputOrigin}` : '',
    signal ? 'references' : '',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    kind: 'incomplete',
    blockCode: 'REVIEW_CONTENT_SOURCE_INCOMPLETE',
    blockMessage: formatBlocked('REVIEW_CONTENT_SOURCE_INCOMPLETE', {
      label: labelParts || 'content field declared but empty or invalid',
    }),
  };
}

function hasConcreteContentField(args: {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): boolean {
  return (
    (typeof args.text === 'string' && args.text.trim().length > 0) ||
    (typeof args.prNumber === 'number' && args.prNumber > 0) ||
    (typeof args.branch === 'string' && args.branch.trim().length > 0) ||
    (typeof args.url === 'string' && args.url.trim().length > 0)
  );
}

function hasDeclaredContentField(args: {
  text?: string;
  prNumber?: number;
  branch?: string;
  url?: string;
}): boolean {
  return (
    args.text !== undefined ||
    args.prNumber !== undefined ||
    args.branch !== undefined ||
    args.url !== undefined
  );
}

export function hasImplicitContentSignal(args: {
  inputOrigin?: string;
  references?: unknown;
}): boolean {
  const hasInputOrigin = typeof args.inputOrigin === 'string' && args.inputOrigin.trim().length > 0;
  const hasReferences =
    args.references !== undefined &&
    Array.isArray(args.references) &&
    (args.references as unknown[]).length > 0;
  return hasInputOrigin || hasReferences;
}
