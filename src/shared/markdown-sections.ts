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

const ATX_HEADING = /^(#{1,6})\s(.*)$/;
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Index ATX Markdown headings and their bounded excerpts. Heading paths are
 * deterministic even when headings have duplicate text or skip a depth.
 */
export function indexMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const headings: ParsedHeading[] = [];
  let openFence: { marker: '`' | '~'; length: number } | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    const openingFence = OPENING_FENCE.exec(line);
    if (openFence) {
      const closingFence = CLOSING_FENCE.exec(line);
      if (
        closingFence &&
        closingFence[1]![0] === openFence.marker &&
        closingFence[1]!.length >= openFence.length
      ) {
        openFence = null;
      }
      continue;
    }
    if (openingFence) {
      openFence = {
        marker: openingFence[1]![0] as '`' | '~',
        length: openingFence[1]!.length,
      };
      continue;
    }
    const match = ATX_HEADING.exec(line);
    if (!match) continue;
    headings.push({
      lineIndex,
      headingDepth: match[1]!.length,
      headingText: match[2]!.trim(),
    });
  }

  const path: MarkdownSectionPathSegment[] = [];
  const siblingCounts = new Map<string, number>();

  return headings.map((heading, index) => {
    while (path.length > 0 && path.at(-1)!.headingDepth >= heading.headingDepth) {
      path.pop();
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
 * Compatibility projection for legacy PlanEvidence.sections consumers.
 * Existing behavior includes only H1 through H3 headings in document order.
 */
export function projectMarkdownHeadings(markdown: string): string[] {
  return indexMarkdownSections(markdown)
    .filter((section) => section.headingDepth <= 3)
    .map((section) => section.headingText);
}
