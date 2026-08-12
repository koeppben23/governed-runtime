/**
 * @module architecture/normalize-host-task-findings-guard
 * @description Architecture guard: normalizeHostTaskFindings MUST NOT perform
 * semantic repair of reviewer findings. It only stamps host-authoritative
 * provenance (reviewedAt, reviewedBy, attestation). No kind mapping, no
 * revision aliasing, no location reconstruction, no verdict reinterpretation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NORMALIZE_FILE = 'integration/review/evidence-binding.ts';
const NORMALIZE_FN = 'normalizeHostTaskFindings';

describe('normalizeHostTaskFindings must not perform semantic repair', () => {
  const content = readFileSync(join(process.cwd(), 'src', NORMALIZE_FILE), 'utf8');
  // Extract the function body: from 'function normalizeHostTaskFindings' to the next 'function' or 'export' at the same indentation level
  const fnStart = content.indexOf(`function ${NORMALIZE_FN}(`);
  expect(fnStart).toBeGreaterThan(-1);

  // Find the function body by tracking brace depth
  let depth = 0;
  let fnEnd = -1;
  let inFn = false;
  for (let i = fnStart; i < content.length; i++) {
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

  const fnBody = content.slice(fnStart, fnEnd);

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
