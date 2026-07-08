/**
 * @module state/discovery-schemas.test
 * @description Contract tests for Zod schemas embedded in SessionState.
 *
 * Tests the 3 state-embedded schemas (DiscoverySummary, DetectedStack,
 * VerificationCandidates) plus the 1 tool-consumed runtime schema
 * (VerificationCandidateKind). Remaining 8 schemas are covered transitively
 * through their parent schemas and integration tests.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect } from 'vitest';
import {
  DiscoverySummarySchema,
  DetectedStackSchema,
  VerificationCandidatesSchema,
  VerificationCandidateKindSchema,
  VerificationCandidateSchema,
} from './discovery-schemas.js';

describe('DiscoverySummarySchema', () => {
  const minimal = {
    primaryLanguages: ['typescript'],
    frameworks: [],
    topologyKind: 'single-project',
    moduleCount: 1,
    hasApiSurface: false,
    hasPersistenceSurface: false,
    hasCiCd: false,
    hasSecuritySurface: false,
  };

  it('parses a minimal valid object', () => {
    const result = DiscoverySummarySchema.parse(minimal);
    expect(result.primaryLanguages).toEqual(['typescript']);
    expect(result.topologyKind).toBe('single-project');
  });

  it('rejects missing required field primaryLanguages', () => {
    const { primaryLanguages: _, ...rest } = minimal;
    const result = DiscoverySummarySchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('primaryLanguages'))).toBe(true);
    }
  });

  it('rejects invalid topologyKind', () => {
    const result = DiscoverySummarySchema.safeParse({ ...minimal, topologyKind: 'nonsense' });
    expect(result.success).toBe(false);
  });
});

describe('DetectedStackSchema', () => {
  const valid = {
    summary: 'TypeScript project with Jest',
    items: [{ kind: 'language', id: 'TypeScript' }],
    versions: [],
  };

  it('parses a valid stack with summary and items', () => {
    const result = DetectedStackSchema.parse(valid);
    expect(result.summary).toBe('TypeScript project with Jest');
    expect(result.items).toHaveLength(1);
  });

  it('rejects missing summary', () => {
    const result = DetectedStackSchema.safeParse({ items: valid.items });
    expect(result.success).toBe(false);
  });
});

describe('VerificationCandidatesSchema', () => {
  it('accepts an empty array', () => {
    expect(VerificationCandidatesSchema.parse([])).toEqual([]);
  });

  it('accepts a valid candidate list', () => {
    const result = VerificationCandidatesSchema.parse([
      {
        kind: 'build',
        command: 'npm run build',
        source: '.github',
        confidence: 'high',
        reason: 'CI',
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('build');
  });
});

describe('VerificationCandidateSchema', () => {
  it('strips unknown extra fields (Zod default strip mode)', () => {
    const result = VerificationCandidateSchema.parse({
      kind: 'build',
      command: 'npm run build',
      source: '.github',
      confidence: 'high',
      reason: 'CI',
      extraField: 'should be removed',
    });
    expect(result).not.toHaveProperty('extraField');
    expect(result.kind).toBe('build');
  });
});

describe('VerificationCandidateKindSchema', () => {
  it('accepts a valid kind value', () => {
    expect(VerificationCandidateKindSchema.parse('build')).toBe('build');
  });

  it('rejects an invalid kind value', () => {
    const result = VerificationCandidateKindSchema.safeParse('invalid');
    expect(result.success).toBe(false);
  });
});
