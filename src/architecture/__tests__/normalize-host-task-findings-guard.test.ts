/**
 * @module architecture/normalize-host-task-findings-guard
 * @description Architecture guard: prepareReviewerFindingsForValidation (the
 * single raw→canonical reviewer-findings authority) MUST NOT perform semantic
 * repair of reviewer findings. It only stamps host-authoritative provenance
 * (reviewedAt, reviewedBy, attestation constants, challenge identity). No kind
 * mapping, no revision aliasing, no location reconstruction, no verdict
 * reinterpretation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NORMALIZE_FILE = 'integration/review/enforcement/prepare-findings.ts';
const NORMALIZE_FN = 'prepareReviewerFindingsForValidation';

describe('prepareReviewerFindingsForValidation must not perform semantic repair', () => {
  const content = readFileSync(join(process.cwd(), 'src', NORMALIZE_FILE), 'utf8');
  const fnStart = content.indexOf(`function ${NORMALIZE_FN}(`);
  expect(fnStart).toBeGreaterThan(-1);

  // The signature contains the destructured `input: { ... }` object, so body
  // extraction must match the full declaration (through the return type) and
  // start brace-tracking at the opening body brace — a naive `) {` search
  // matches `if (...) {` inside the body itself.
  const declaration = content.match(
    new RegExp(`function ${NORMALIZE_FN}\\([\\s\\S]*?\\):\\s*\\w+\\s*\\{`),
  );
  expect(declaration).not.toBeNull();
  const match = declaration as RegExpMatchArray;
  const matchIndex = match.index ?? -1;
  expect(matchIndex).toBeGreaterThan(-1);
  const bodyBrace = matchIndex + match[0].length - 1;

  // Find the function body by tracking brace depth
  let depth = 0;
  let fnEnd = -1;
  let inFn = false;
  for (let i = bodyBrace; i < content.length; i++) {
    if (content[i] === '{') {
      depth++;
      inFn = true;
    } else if (content[i] === '}') {
      depth--;
      if (inFn && depth === 0) {
        fnEnd = i + 1;
        break;
      }
    }
  }
  expect(fnEnd).toBeGreaterThan(-1);

  const fnBody = content.slice(bodyBrace, fnEnd);

  it('does not map kind values', () => {
    // Must not contain kind-repair logic
    expect(fnBody).not.toMatch(/\bkind\s*[:=]\s*['"]/);
    expect(fnBody).not.toMatch(/file_path/);
    expect(fnBody).not.toMatch(/source_file/);
  });

  it('does not alias revision values', () => {
    expect(fnBody).not.toMatch(/revision\s*=\s*['"]head['"]\s*:/);
    expect(fnBody).not.toMatch(/revision\s*=\s*['"]base['"]\s*:/);
    // No mapping from 'current' or 'modified' to 'head'
    expect(fnBody).not.toMatch(/current/);
    expect(fnBody).not.toMatch(/modified/);
  });

  it('does not reconstruct missing location objects', () => {
    expect(fnBody).not.toMatch(/location\s*=\s*\{/);
    expect(fnBody).not.toMatch(/location\.path/);
  });

  it('does not reinterpret verdict values', () => {
    expect(fnBody).not.toMatch(/overallVerdict\s*=/);
    expect(fnBody).not.toMatch(/verdict\s*=\s*['"]accept/);
  });

  it('only stamps host-authoritative identity and attestation', () => {
    // The function should call applyHostProvenance (identity stamping)
    expect(fnBody).toContain('applyHostProvenance');
    // The function should deal with attestation
    expect(fnBody).toContain('attestation');
    // Must not contain repair-specific logic
    expect(fnBody).not.toContain('evidenceLocations');
    expect(fnBody).not.toContain('subjectAnchors');
  });
});
