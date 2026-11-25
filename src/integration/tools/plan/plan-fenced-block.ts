/**
 * @module integration/tools/plan/plan-fenced-block
 * @description Deterministic extraction of one named fenced block from a plan.
 *
 * The plan body is author-controlled Markdown. A contract block is recognized
 * only by its exact info string. Missing, duplicate, unclosed, or malformed
 * blocks are explicit outcomes; this module never repairs author text.
 */

import { normalizeReviewArtifactText } from '../../../shared/review-artifact-text.js';

export type FencedBlockResult =
  | { readonly kind: 'ok'; readonly content: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'unclosed' };

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Fence {
  readonly marker: string;
  readonly length: number;
  readonly info: string;
}

interface OpenFence extends Fence {
  readonly lines: string[];
}

function openingFence(line: string): Fence | null {
  const match = OPENING_FENCE.exec(line);
  const markerText = match?.[1];
  if (markerText === undefined) return null;
  return {
    marker: markerText.charAt(0),
    length: markerText.length,
    info: (match?.[2] ?? '').trim(),
  };
}

function closes(line: string, open: Fence): boolean {
  const fence = openingFence(line);
  return (
    fence !== null &&
    fence.marker === open.marker &&
    fence.length >= open.length &&
    fence.info === ''
  );
}

/** Extract exactly one fenced block whose info string equals `language`. */
export function extractFencedBlock(planText: string, language: string): FencedBlockResult {
  let open: OpenFence | null = null;
  let found: string | null = null;

  for (const line of normalizeReviewArtifactText(planText).split('\n')) {
    if (open === null) {
      const fence = openingFence(line);
      if (fence !== null) open = { ...fence, lines: [] };
      continue;
    }
    if (closes(line, open)) {
      if (open.info === language) {
        if (found !== null) return { kind: 'duplicate' };
        found = open.lines.join('\n').trim();
      }
      open = null;
      continue;
    }
    if (open.info === language) open.lines.push(line);
  }

  if (open?.info === language) return { kind: 'unclosed' };
  return found === null ? { kind: 'missing' } : { kind: 'ok', content: found };
}
