/**
 * @module integration/artifacts/madr-writer.test
 * @description Tests for the MADR artifact writer.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeMadrArtifact, formatMadrContent, madrFileName } from './madr-writer';
import { ARCHITECTURE_DECISION, FIXED_TIME } from '../../__fixtures__';
import { benchmarkSync } from '../../test-policy';

// ─── Test Setup ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-madr-'));
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('madr-writer', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('writes MADR file to session directory', async () => {
      const filePath = await writeMadrArtifact(tmpDir, ARCHITECTURE_DECISION);
      expect(filePath).toBe(path.join(tmpDir, 'ADR-1.md'));

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('# ADR-1: Use PostgreSQL for primary storage');
      expect(content).toContain('## Context');
      expect(content).toContain('## Decision');
      expect(content).toContain('## Consequences');
    });

    it('includes metadata header (status, date, digest)', async () => {
      const filePath = await writeMadrArtifact(tmpDir, ARCHITECTURE_DECISION);
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('- Status: proposed');
      expect(content).toContain(`- Date: ${FIXED_TIME}`);
      expect(content).toContain('- Digest: digest-of-adr');
      expect(content).toContain('- Schema: madr-artifact.v1');
    });

    it('returns the absolute file path', async () => {
      const filePath = await writeMadrArtifact(tmpDir, ARCHITECTURE_DECISION);
      expect(path.isAbsolute(filePath)).toBe(true);
      expect(filePath.endsWith('ADR-1.md')).toBe(true);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('throws on unwritable directory', async () => {
      const badDir = path.join(tmpDir, 'no-exist', 'deep', 'nested');
      // writeMadrArtifact creates the directory, so this should actually work
      // Test with an invalid path character instead
      await expect(
        writeMadrArtifact(
          // Path with null byte — invalid on all OSes
          path.join(tmpDir, 'bad\0dir'),
          ARCHITECTURE_DECISION,
        ),
      ).rejects.toThrow();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('creates session directory if it does not exist', async () => {
      const nestedDir = path.join(tmpDir, 'deep', 'nested', 'session');
      const filePath = await writeMadrArtifact(nestedDir, ARCHITECTURE_DECISION);
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);
    });

    it('overwrites existing MADR file (idempotent)', async () => {
      await writeMadrArtifact(tmpDir, ARCHITECTURE_DECISION);
      const updatedAdr = {
        ...ARCHITECTURE_DECISION,
        status: 'accepted' as const,
      };
      const filePath = await writeMadrArtifact(tmpDir, updatedAdr);
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('- Status: accepted');
    });

    it('handles ADR IDs with large numbers', async () => {
      const adr = { ...ARCHITECTURE_DECISION, id: 'ADR-9999' };
      const filePath = await writeMadrArtifact(tmpDir, adr);
      expect(filePath.endsWith('ADR-9999.md')).toBe(true);
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('formatMadrContent is pure (no side effects)', () => {
      const content1 = formatMadrContent(ARCHITECTURE_DECISION);
      const content2 = formatMadrContent(ARCHITECTURE_DECISION);
      expect(content1).toBe(content2);
    });

    it('madrFileName derives correct filename', () => {
      expect(madrFileName('ADR-1')).toBe('ADR-1.md');
      expect(madrFileName('ADR-42')).toBe('ADR-42.md');
      expect(madrFileName('ADR-100')).toBe('ADR-100.md');
    });

    it('MADR content ends with trailing newline', () => {
      const content = formatMadrContent(ARCHITECTURE_DECISION);
      expect(content.endsWith('\n')).toBe(true);
    });

    it('MADR title line uses id: title format', () => {
      const content = formatMadrContent(ARCHITECTURE_DECISION);
      const firstLine = content.split('\n')[0];
      expect(firstLine).toBe('# ADR-1: Use PostgreSQL for primary storage');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('formatMadrContent is fast (< 1ms p99 over 1000 iterations)', () => {
      const { p99Ms } = benchmarkSync(() => {
        formatMadrContent(ARCHITECTURE_DECISION);
      }, 1000);
      expect(p99Ms).toBeLessThan(1);
    });
  });
});
