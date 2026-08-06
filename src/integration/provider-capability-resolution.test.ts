/**
 * @module integration/provider-capability-resolution.test
 * @description Tests für die Runtime-Capability-Projektion.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveProviderCapabilities,
  type ResolvedProviderCapability,
} from './provider-capability-resolution.js';
import type { DetectedStack, VerificationCandidate } from '../state/discovery-schemas.js';

function makeDetectedStack(items: Array<{ kind: string; id: string }>): DetectedStack {
  return {
    summary: '',
    items: items.map((i) => ({
      kind: i.kind as DetectedStack['items'][number]['kind'],
      id: i.id,
    })),
    versions: [],
  };
}

function makeStructuredCandidate(
  providerId: string,
  overrides?: Partial<VerificationCandidate>,
): VerificationCandidate {
  return {
    assertionCapability: 'structured' as const,
    kind: 'test',
    command: 'run',
    source: `test:${providerId}`,
    confidence: 'medium',
    reason: 'test',
    ...overrides,
    assertionReport: {
      collection: 'run_specific' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: providerId as never,
      outputArgumentTemplate: '--out={attemptId}',
      resultPatternTemplate: '{attemptId}.xml',
    },
  } as VerificationCandidate;
}

describe('resolveProviderCapabilities', () => {
  it('returns 5 provider entries regardless of detection', () => {
    const result = resolveProviderCapabilities(undefined, undefined);
    expect(result).toHaveLength(5);
    const ids = result.map((r) => r.providerId);
    expect(new Set(ids).size).toBe(5);
  });

  it('sets detection: not_detected when no stack provided', () => {
    const result = resolveProviderCapabilities(undefined, undefined);
    for (const r of result) {
      expect(r.detection.status).toBe('not_detected');
      expect(r.detection.evidence).toHaveLength(0);
    }
  });

  it('detects vitest from testFramework:vitest', () => {
    const stack = makeDetectedStack([{ kind: 'testFramework', id: 'vitest' }]);
    const result = resolveProviderCapabilities(stack, undefined);
    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.detection.status).toBe('detected');
    expect(vitest.detection.evidence).toContain('testFramework:vitest');
  });

  it('deduplicates multiple detection IDs to one provider entry', () => {
    const stack = makeDetectedStack([
      { kind: 'testFramework', id: 'go_test' },
      { kind: 'language', id: 'go' },
    ]);
    const result = resolveProviderCapabilities(stack, undefined);
    const goEntries = result.filter((r) => r.providerId === 'go_test');
    expect(goEntries).toHaveLength(1);
    const go = goEntries[0]!;
    expect(go.detection.status).toBe('detected');
    expect(go.detection.evidence).toContain('testFramework:go_test');
    expect(go.detection.evidence).toContain('language:go');
  });

  it('assertionBinding is available for registered codec providers', () => {
    const result = resolveProviderCapabilities(undefined, undefined);
    const junit = result.find((r) => r.providerId === 'junit')!;
    expect(junit.assertionBinding.status).toBe('available');
    expect(junit.assertionBinding.format).toBe('junit_xml');

    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.assertionBinding.status).toBe('available');
  });

  it('candidate status available when matching candidate exists', () => {
    const candidates = [
      makeStructuredCandidate('vitest', {
        source: 'detectedStack:testFramework:vitest',
      }),
    ];
    const result = resolveProviderCapabilities(undefined, candidates);
    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.candidate.status).toBe('available');
    expect(vitest.candidate.source).toBe('detectedStack:testFramework:vitest');
  });

  it('candidate status unavailable when no matching candidate', () => {
    const result = resolveProviderCapabilities(undefined, undefined);
    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.candidate.status).toBe('unavailable');
    expect(vitest.candidate.source).toBeUndefined();
  });

  it('non-structured candidates are not mapped to providers', () => {
    const candidates: VerificationCandidate[] = [
      {
        assertionCapability: 'unsupported' as const,
        kind: 'test',
        command: 'npm test',
        source: 'package.json',
        confidence: 'high',
        reason: 'test',
      },
    ];
    const result = resolveProviderCapabilities(undefined, candidates);
    for (const r of result) {
      expect(r.candidate.status).toBe('unavailable');
    }
  });
});
