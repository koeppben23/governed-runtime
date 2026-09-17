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
        candidateId: 'vc_build_ci',
        assertionCapability: 'unsupported' as const,
        kind: 'build',
        command: 'npm run build',
        source: '.github',
        confidence: 'high',
        reason: 'CI',
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('build');
  });
});

describe('VerificationCandidateSchema', () => {
  const base = {
    assertionCapability: 'unsupported' as const,
    kind: 'build',
    command: 'npm run build',
    source: '.github',
    confidence: 'high',
    reason: 'CI',
  };

  it('requires the planner-minted candidateId', () => {
    expect(VerificationCandidateSchema.safeParse(base).success).toBe(false);
    expect(VerificationCandidateSchema.safeParse({ ...base, candidateId: 'vc_x' }).success).toBe(
      true,
    );
  });

  it('rejects unknown extra fields instead of stripping them', () => {
    const result = VerificationCandidateSchema.safeParse({
      ...base,
      candidateId: 'vc_x',
      extraField: 'must reject',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields inside the nested assertion report', () => {
    const structured = {
      candidateId: 'vc_y',
      assertionCapability: 'structured' as const,
      kind: 'test',
      command: 'npm test',
      source: 'package.json',
      confidence: 'medium',
      reason: 'test',
      assertionReport: {
        collection: 'stdout' as const,
        transport: 'stdout' as const,
        format: 'junit_xml',
        providerId: 'junit',
        injected: 'must reject',
      },
    };
    expect(VerificationCandidateSchema.safeParse(structured).success).toBe(false);
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
