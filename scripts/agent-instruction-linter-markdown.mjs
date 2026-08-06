/**
 * agent-instruction-linter-markdown.mjs
 *
 * Section extraction, canonical scope/verification validation, and
 * advisory duplicate-paragraph detection for repository instruction files.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CANONICAL_SCOPE = 'This file adds instructions for files in this directory subtree.';
const CANONICAL_VERIFICATION =
  'Apply the repository-wide verification rules first. In addition:';

const ALLOWED_DUPLICATE = new Set([
  normalizeParagraph(CANONICAL_SCOPE),
  normalizeParagraph(CANONICAL_VERIFICATION),
]);

function readFile(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

// ── Fenced code block masking ────────────────────────────────────────

const FENCE_LINE = /^(```+|~~~+)\s*$/m;

/**
 * Replaces fenced code block bodies with blank lines, preserving line
 * counts but removing their content from structural analysis.
 * Handles 3+ backtick fences and 3+ tilde fences.
 */
export function maskFencedCodeBlocks(content) {
  const lines = content.split('\n');
  const result = [];
  let inFence = false;
  let fenceMarker = '';

  for (const line of lines) {
    const m = line.match(/^(```+|~~~+)(\s|$)/);
    if (m) {
      const marker = m[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        result.push(line);
      } else if (marker.length >= fenceMarker.length && marker[0] === fenceMarker[0]) {
        inFence = false;
        fenceMarker = '';
        result.push(line);
      } else {
        result.push(line);
      }
    } else {
      result.push(inFence ? '' : line);
    }
  }

  return result.join('\n');
}

function stripCodeBlocks(content) {
  return maskFencedCodeBlocks(content);
}

// ── Section extraction ────────────────────────────────────────────────

/**
 * Extracts the body of a Markdown section at heading level `level` (1–6).
 * Stops at the next heading of equal or higher rank (`#{1,level}`) outside
 * fenced code blocks. Returns the body text (without the heading line).
 */
export function extractMarkdownSection(content, heading, level) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^${'#'.repeat(level)}\\s+${escaped}\\s*$`, 'm');
  const startMatch = content.match(startRe);
  if (!startMatch || startMatch.index === undefined) return null;

  const bodyStart = startMatch.index + startMatch[0].length;
  let rest = content.slice(bodyStart);

  // skip leading blank lines in the section body
  rest = rest.replace(/^\n+/, '');

  const stopRe = new RegExp(`^#{1,${level}}\\s+`, 'm');

  // Search for stop heading outside code blocks, scanning sequentially.
  // Skip over fenced code blocks when searching.
  let searchFrom = 0;
  let blockStart = rest.indexOf('```');

  while (blockStart !== -1) {
    const blockEnd = rest.indexOf('```', blockStart + 3);
    if (blockEnd === -1) break;

    // Search for stop heading in text before this code block
    const beforeBlock = rest.slice(searchFrom, blockStart);
    stopRe.lastIndex = 0;
    const match = stopRe.exec(beforeBlock);
    if (match) {
      return rest.slice(0, searchFrom + match.index).trimEnd();
    }

    searchFrom = blockEnd + 3;
    blockStart = rest.indexOf('```', searchFrom);
  }

  // Search remaining text after last code block
  const afterLastBlock = rest.slice(searchFrom);
  stopRe.lastIndex = 0;
  const match = stopRe.exec(afterLastBlock);
  if (match) {
    return rest.slice(0, searchFrom + match.index).trimEnd();
  }

  // No stop heading found — return full body
  return rest.trimEnd();
}

// ── Check 9: Canonical Scope section ──────────────────────────────────

export function checkCanonicalScope(root, nested, diagnostics) {
  for (const file of nested) {
    const content = readFile(root, file);
    const section = extractMarkdownSection(content, 'Scope', 2);
    if (!section || section.trim() !== CANONICAL_SCOPE) {
      diagnostics.push({
        file,
        kind: 'error',
        message: 'missing canonical Scope section',
      });
    }
  }
}

// ── Check 11: Additive Verification section ───────────────────────────

export function checkAdditiveVerification(root, nested, diagnostics) {
  for (const file of nested) {
    const content = readFile(root, file);
    const section = extractMarkdownSection(content, 'Additional Verification for This Subtree', 2);
    if (!section) {
      diagnostics.push({
        file,
        kind: 'error',
        message: 'missing Additional Verification for This Subtree section',
      });
      continue;
    }
    const firstLine = section.split('\n')[0].trim();
    if (firstLine !== CANONICAL_VERIFICATION) {
      diagnostics.push({
        file,
        kind: 'error',
        message:
          'Additional Verification section must start with canonical additive rule',
      });
    }
  }
}

// ── Paragraph normalization ───────────────────────────────────────────

function normalizeParagraph(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── Check 12: Duplicate paragraphs (advisory) ─────────────────────────

export function checkDuplicateParagraphs(root, agents, diagnostics) {
  const occurrences = new Map();

  for (const file of agents) {
    const content = readFile(root, file);
    const body = stripCodeBlocks(content);
    const paragraphs = body.split(/\n\n+/);

    for (const para of paragraphs) {
      const norm = normalizeParagraph(para);
      if (norm.length < 40) continue;
      if (/^#+\s/.test(norm)) continue;
      if (ALLOWED_DUPLICATE.has(norm)) continue;

      const list = occurrences.get(norm) ?? [];
      list.push(file);
      occurrences.set(norm, list);
    }
  }

  for (const [norm, files] of occurrences) {
    if (files.length < 2) continue;
    diagnostics.push({
      kind: 'warn',
      message: `duplicated instruction paragraph appears in:\n${files.map((f) => `- ${f}`).join('\n')}`,
    });
  }
}
