/**
 * @module shared/markdown-sections
 * @description Canonical deterministic Markdown section indexing.
 */

import { hashText } from './hashing.js';

export interface MarkdownSectionPathSegment {
  /** Markdown ATX heading depth (one through six). */
  readonly headingDepth: number;
  /** One-based ordinal among headings with the same parent and depth. */
  readonly siblingIndex: number;
  /** Presentation text only; it is not part of the section identity. */
  readonly headingText: string;
}

export interface MarkdownSection {
  readonly headingDepth: number;
  readonly siblingIndex: number;
  /** Deterministic identity path, rooted at the nearest shallower heading. */
  readonly sectionPath: readonly MarkdownSectionPathSegment[];
  readonly headingText: string;
  /** The exact heading and body text through the next same-or-shallower heading. */
  readonly excerptText: string;
  /** SHA-256 digest of {@link excerptText}. */
  readonly excerptDigest: string;
}

interface ParsedHeading {
  readonly lineIndex: number;
  readonly headingDepth: number;
  readonly headingText: string;
}

interface ParsedFence {
  readonly marker: '`' | '~';
  readonly length: number;
}

const ATX_HEADING = /^(#{1,6})\s(.*)$/;
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function parseFence(line: string, pattern: RegExp): ParsedFence | null {
  const match = pattern.exec(line);
  if (match === null) return null;
  const markerText = match[1];
  if (markerText === undefined) return null;
  const marker = markerText.charAt(0);
  if (marker !== '`' && marker !== '~') return null;
  return { marker, length: markerText.length };
}

function parseAtxHeading(line: string, lineIndex: number): ParsedHeading | null {
  const match = ATX_HEADING.exec(line);
  if (match === null) return null;
  const depthHashes = match[1];
  const headingText = match[2];
  if (depthHashes === undefined || headingText === undefined) return null;
  return { lineIndex, headingDepth: depthHashes.length, headingText: headingText.trim() };
}

/**
 * Index ATX Markdown headings and their bounded excerpts. Heading paths are
 * deterministic even when headings have duplicate text or skip a depth.
 */
export function indexMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const headings: ParsedHeading[] = [];
  let openFence: ParsedFence | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    if (openFence) {
      const closingFence = parseFence(line, CLOSING_FENCE);
      if (
        closingFence !== null &&
        closingFence.marker === openFence.marker &&
        closingFence.length >= openFence.length
      ) {
        openFence = null;
      }
      continue;
    }
    const openingFence = parseFence(line, OPENING_FENCE);
    if (openingFence !== null) {
      openFence = openingFence;
      continue;
    }
    const heading = parseAtxHeading(line, lineIndex);
    if (heading === null) continue;
    headings.push(heading);
  }

  const path: MarkdownSectionPathSegment[] = [];
  const siblingCounts = new Map<string, number>();

  return headings.map((heading, index) => {
    let lastSegment = path.at(-1);
    while (lastSegment !== undefined && lastSegment.headingDepth >= heading.headingDepth) {
      path.pop();
      lastSegment = path.at(-1);
    }

    const parentKey = path
      .map(({ headingDepth, siblingIndex }) => `${headingDepth}:${siblingIndex}`)
      .join('/');
    const siblingKey = `${parentKey}|${heading.headingDepth}`;
    const siblingIndex = (siblingCounts.get(siblingKey) ?? 0) + 1;
    siblingCounts.set(siblingKey, siblingIndex);

    const segment: MarkdownSectionPathSegment = {
      headingDepth: heading.headingDepth,
      siblingIndex,
      headingText: heading.headingText,
    };
    path.push(segment);

    const nextBoundary = headings
      .slice(index + 1)
      .find((candidate) => candidate.headingDepth <= heading.headingDepth);
    const excerptText = lines
      .slice(heading.lineIndex, nextBoundary?.lineIndex ?? lines.length)
      .join('\n');

    return {
      headingDepth: heading.headingDepth,
      siblingIndex,
      sectionPath: [...path],
      headingText: heading.headingText,
      excerptText,
      excerptDigest: hashText(excerptText),
    };
  });
}

/**
 * Project the canonical `PlanEvidence.sections` heading list from a markdown body.
 * Includes only H1 through H3 headings, in document order.
 */
export function projectMarkdownHeadings(markdown: string): string[] {
  return indexMarkdownSections(markdown)
    .filter((section) => section.headingDepth <= 3)
    .map((section) => section.headingText);
}
