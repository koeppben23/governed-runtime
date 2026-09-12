/**
 * @module documentation/__tests__/opencode-host-boundary-attack-matrix
 * @description Drift guard for the OpenCode host boundary attack matrix.
 *
 * The matrix is the review ledger for the OpenCode host/plugin/SDK boundary.
 * This test keeps it honest: scenario IDs are unique, every scenario has a
 * valid status, every referenced finding is defined, and every referenced
 * artifact exists in the repository.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MATRIX_PATH = join(REPO_ROOT, 'docs', 'opencode-host-boundary-attack-matrix.md');
const INDEX_PATH = join(REPO_ROOT, 'docs', 'index.md');

const REQUIRED_SECTIONS = [
  '## Purpose',
  '## Scope And Threat Model',
  '## How To Read The Matrix',
  '## Findings',
  '## Remediation Order',
  '## Next Passes',
] as const;

const VALID_STATUSES = new Set(['Covered', 'Partial', 'Gap', 'Residual']);

interface ScenarioRow {
  readonly id: string;
  readonly status: string;
  readonly findings: readonly string[];
}

function readMatrix(): string {
  return readFileSync(MATRIX_PATH, 'utf-8');
}

function parseScenarioRows(content: string): ScenarioRow[] {
  const rows: ScenarioRow[] = [];
  for (const line of content.split('\n')) {
    if (!/^\| [A-Z]{2}-\d{2} \|/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const id = cells[1] ?? '';
    const status = cells[5] ?? '';
    const findingCell = cells[6] ?? '';
    const findings = Array.from(findingCell.matchAll(/F-\d{2}/g), (match) => match[0]);
    rows.push({ id, status, findings });
  }
  return rows;
}

function parseFindingIds(content: string): string[] {
  return Array.from(content.matchAll(/^### (F-\d{2}) — /gm), (match) => match[1] ?? '');
}

function parseRepoArtifactRefs(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(/`((?:src|scripts|docs|\.sdk-baselines)\/[^`]+)`/g)) {
    const raw = match[1] ?? '';
    refs.add(raw.replace(/:\d+(?:-\d+)?$/, ''));
  }
  return [...refs];
}

describe('documentation/opencode-host-boundary-attack-matrix', () => {
  const content = readMatrix();
  const rows = parseScenarioRows(content);
  const findingIds = parseFindingIds(content);

  describe('HAPPY — matrix structure', () => {
    it('declares the review ledger sections', () => {
      for (const section of REQUIRED_SECTIONS) {
        expect(content, `missing section ${section}`).toContain(section);
      }
    });

    it('documents at least 40 scenarios with unique ids', () => {
      expect(rows.length).toBeGreaterThanOrEqual(40);
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('defines every finding referenced by a scenario', () => {
      const referenced = new Set(rows.flatMap((row) => row.findings));
      expect(referenced.size).toBeGreaterThan(0);
      for (const finding of referenced) {
        expect(findingIds, `undefined finding ${finding}`).toContain(finding);
      }
    });
  });

  describe('BAD — invalid entries are rejected', () => {
    it('rejects unknown scenario statuses', () => {
      for (const row of rows) {
        expect(VALID_STATUSES.has(row.status), `${row.id} has status ${row.status}`).toBe(true);
      }
    });

    it('requires every finding to declare severity and status', () => {
      for (const finding of findingIds) {
        const section = content.split(`### ${finding} — `)[1]?.split('### ')[0] ?? '';
        expect(section, `${finding} missing severity`).toContain('**Severity:**');
        expect(section, `${finding} missing status`).toContain('**Status:**');
      }
    });
  });

  describe('CORNER — artifacts stay referenced', () => {
    it('references artifacts that exist in the repository', () => {
      const refs = parseRepoArtifactRefs(content);
      expect(refs.length).toBeGreaterThan(10);
      for (const ref of refs) {
        expect(existsSync(join(REPO_ROOT, ref)), `missing artifact ${ref}`).toBe(true);
      }
    });

    it('is linked from docs/index.md', () => {
      const index = readFileSync(INDEX_PATH, 'utf-8');
      expect(index).toContain('./opencode-host-boundary-attack-matrix.md');
    });
  });

  describe('EDGE — deliberate counts cannot silently shrink', () => {
    it('keeps at least 13 findings', () => {
      expect(findingIds.length).toBeGreaterThanOrEqual(13);
    });

    it('keeps every declared finding unique', () => {
      expect(new Set(findingIds).size).toBe(findingIds.length);
    });
  });
});
