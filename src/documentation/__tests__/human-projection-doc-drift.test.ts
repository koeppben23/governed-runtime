/**
 * @module documentation/__tests__/human-projection-doc-drift
 * @description Bidirectional drift guard between the canonical human copy table
 * (REASON_COPY) and the troubleshooting documentation's migrated-code table.
 *
 * The copy table is the single authority for migrated human copy. Docs must
 * mirror it exactly: the same code set, headline, and explanation. A drift on
 * either side (a documented code that was never migrated, or migrated copy the
 * docs no longer show) fails here.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASON_COPY } from '../../presentation/reason-copy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

interface DocumentedCopyRow {
  code: string;
  headline: string;
  explanation: string;
}

function readTroubleshooting(): string {
  return readFileSync(join(REPO_ROOT, 'docs/troubleshooting.md'), 'utf-8').replace(/\r\n/g, '\n');
}

function extractMigratedTable(): DocumentedCopyRow[] {
  const content = readTroubleshooting();
  const section = content.match(/## Migrated Reason Codes \(Human Projection\)[\s\S]*?(?=^## )/m);
  expect(
    section,
    'docs/troubleshooting.md must contain a Migrated Reason Codes section before the next heading',
  ).toBeTruthy();
  const rows: DocumentedCopyRow[] = [];
  for (const line of section![0].split('\n')) {
    // Tolerate prettier column alignment: cells are space-padded, so the code
    // cell may carry padding after its closing backtick and text cells may
    // carry trailing padding. Trim the captured text cells before comparing.
    const match = line.match(/^\| `([A-Z][A-Z0-9_]+)`[ ]*\| (.*) \| (.*) \|$/);
    if (!match) continue;
    rows.push({ code: match[1]!, headline: match[2]!.trim(), explanation: match[3]!.trim() });
  }
  return rows;
}

function copyIndex() {
  return new Map(REASON_COPY.map((entry) => [entry.code, entry]));
}

describe('documentation/human-projection-doc-drift', () => {
  describe('HAPPY — every migrated code is documented', () => {
    it('every REASON_COPY code appears in the troubleshooting table', () => {
      const documented = new Set(extractMigratedTable().map((row) => row.code));
      const missing = REASON_COPY.filter((entry) => !documented.has(entry.code)).map(
        (entry) => entry.code,
      );
      expect(missing).toEqual([]);
    });
  });

  describe('BAD — documented human copy cannot be phantom', () => {
    it('every documented table code is a migrated REASON_COPY code', () => {
      const migrated = new Set(REASON_COPY.map((entry) => entry.code));
      const phantom = extractMigratedTable()
        .map((row) => row.code)
        .filter((code) => !migrated.has(code));
      expect(phantom).toEqual([]);
    });
  });

  describe('CORNER — documented copy matches the canonical table verbatim', () => {
    it('headline and explanation match REASON_COPY exactly for every row', () => {
      const index = copyIndex();
      for (const row of extractMigratedTable()) {
        const entry = index.get(row.code);
        expect(entry, `${row.code} must resolve in REASON_COPY`).toBeTruthy();
        expect(row.headline, `${row.code} headline drifted`).toBe(entry!.headline);
        expect(row.explanation, `${row.code} explanation drifted`).toBe(entry!.explanation);
      }
    });
  });

  describe('EDGE — table has no duplicate rows', () => {
    it('each code appears exactly once in the troubleshooting table', () => {
      const rows = extractMigratedTable();
      expect(new Set(rows.map((row) => row.code)).size).toBe(rows.length);
    });
  });
});
