/**
 * @module evidence-architecture.test
 * @description Tests for evidence-architecture module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  ArchitectureDecision,
  REQUIRED_ADR_SECTIONS,
  validateAdrSections,
} from './evidence-architecture.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-architecture', () => {
  describe('HAPPY', () => {
    it('ArchitectureDecision parses valid ADR', () => {
      const adr = {
        id: 'ADR-1',
        title: 'Use PostgreSQL',
        adrText:
          '## Context\nWe need a DB\n\n## Decision\nUse PostgreSQL\n\n## Consequences\nMaintain DB infra',
        status: 'proposed' as const,
        createdAt: FIXED_TIME,
        digest: 'sha256-adr',
      };
      expect(ArchitectureDecision.parse(adr)).toEqual(adr);
    });

    it('ArchitectureDecision accepts reviewFindings', () => {
      const adr = {
        id: 'ADR-42',
        title: 'Test ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        status: 'accepted' as const,
        createdAt: FIXED_TIME,
        digest: 'sha256-deadbeef',
        reviewFindings: [],
      };
      expect(ArchitectureDecision.parse(adr)).toEqual(adr);
    });

    it('validateAdrSections returns empty for valid ADR', () => {
      const adrText =
        '## Context\nBackground\n\n## Decision\nDo X\n\n## Consequences\nY will happen';
      expect(validateAdrSections(adrText)).toEqual([]);
    });

    it('REQUIRED_ADR_SECTIONS has 3 sections', () => {
      expect(REQUIRED_ADR_SECTIONS).toEqual(['## Context', '## Decision', '## Consequences']);
    });
  });

  describe('BAD', () => {
    it('ArchitectureDecision rejects invalid ADR id format', () => {
      expect(() =>
        ArchitectureDecision.parse({
          id: 'ADR-X',
          title: 'Test',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          status: 'proposed',
          createdAt: FIXED_TIME,
          digest: 'abc',
        }),
      ).toThrow();
    });

    it('ArchitectureDecision rejects ADR without number', () => {
      expect(() =>
        ArchitectureDecision.parse({
          id: 'ADR-',
          title: 'Test',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          status: 'proposed',
          createdAt: FIXED_TIME,
          digest: 'abc',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('validateAdrSections detects missing sections', () => {
      expect(validateAdrSections('## Context\nBackground')).toEqual([
        '## Decision',
        '## Consequences',
      ]);
      expect(validateAdrSections('')).toEqual(['## Context', '## Decision', '## Consequences']);
    });

    it('ArchitectureDecision with absent reviewFindings is valid (legacy compat)', () => {
      const adr = {
        id: 'ADR-1',
        title: 'Legacy ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        status: 'proposed' as const,
        createdAt: FIXED_TIME,
        digest: 'abc',
      };
      expect(ArchitectureDecision.parse(adr)).toEqual(adr);
    });
  });

  describe('EDGE', () => {
    it('ArchitectureDecision rejects empty title', () => {
      expect(() =>
        ArchitectureDecision.parse({
          id: 'ADR-1',
          title: '',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          status: 'proposed',
          createdAt: FIXED_TIME,
          digest: 'abc',
        }),
      ).toThrow();
    });
  });
});
