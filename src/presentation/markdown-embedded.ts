/**
 * @module presentation/markdown-embedded
 * @description Structural normalization for untrusted embedded Markdown.
 *
 * Boundary-trims, sanitises structural whitespace, and demotes ATX headings so
 * the shallowest heading is at least a minimum level. Fenced code blocks are
 * opaque: their content (and internal blank lines/indentation) is preserved
 * verbatim.
 *
 * @version v1
 */

/**
 * Normalise untrusted embedded Markdown for safe inclusion in a document:
 * boundary-trims, sanitises structural whitespace, and demotes ATX headings so
 * the shallowest heading is at least `minLevel`. Fenced code blocks are opaque:
 * their content (and internal blank lines/indentation) is preserved verbatim.
 */
export function normalizeEmbeddedContent(raw: string, minLevel: number): string {
  const boundaryTrimmed = raw.replace(/^\n+/, '').replace(/\n+$/, '');
  if (boundaryTrimmed.length === 0) return '';

  const shallowest = shallowestHeadingLevel(boundaryTrimmed);
  const shift = shallowest !== null && shallowest < minLevel ? minLevel - shallowest : 0;

  const lines = boundaryTrimmed.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  let prevBlankOutsideFence = false;

  for (const line of lines) {
    const fence = fenceDelimiter(line);
    if (fence !== null && (!inFence || line.trimStart().startsWith(fenceMarker))) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence;
      } else {
        inFence = false;
        fenceMarker = '';
      }
      out.push(line); // fence delimiter lines are preserved verbatim
      prevBlankOutsideFence = false;
      continue;
    }
    if (inFence) {
      out.push(line); // code content preserved verbatim (exempt from all normalisation)
      continue;
    }
    const sanitized = sanitizeStructuralLine(demoteHeadingLine(line, shift));
    const blank = sanitized.length === 0;
    // Collapse triple+ newlines between structural blocks: never allow two
    // consecutive blank lines outside a code fence.
    if (blank && prevBlankOutsideFence) continue;
    out.push(sanitized);
    prevBlankOutsideFence = blank;
  }

  return out.join('\n');
}

/** Return the ``` / ~~~ fence marker if the line opens/closes a fenced block. */
function fenceDelimiter(line: string): string | null {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  return m?.[1] ?? null;
}

/** Strip trailing whitespace from a non-code line. */
function sanitizeStructuralLine(line: string): string {
  return line.replace(/[ \t]+$/, '');
}

/** Demote an ATX heading line by `shift` levels (capped at H6). No-op otherwise. */
function demoteHeadingLine(line: string, shift: number): string {
  if (shift <= 0) return line;
  const m = /^(#{1,6})(\s.*)$/.exec(line);
  if (!m) return line;
  const levelHashes = m[1];
  const headingText = m[2];
  if (levelHashes === undefined || headingText === undefined) return line;
  const level = Math.min(6, levelHashes.length + shift);
  return '#'.repeat(level) + headingText;
}

/** Shallowest (smallest) ATX heading level in fence-external content, or null. */
function shallowestHeadingLevel(content: string): number | null {
  let inFence = false;
  let fenceMarker = '';
  let shallowest: number | null = null;
  for (const line of content.split('\n')) {
    const fence = fenceDelimiter(line);
    if (fence !== null && (!inFence || line.trimStart().startsWith(fenceMarker))) {
      inFence = !inFence;
      fenceMarker = inFence ? fence : '';
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s/.exec(line);
    const levelHashes = m?.[1];
    if (levelHashes !== undefined && (shallowest === null || levelHashes.length < shallowest)) {
      shallowest = levelHashes.length;
    }
  }
  return shallowest;
}
