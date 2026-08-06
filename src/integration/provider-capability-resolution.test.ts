/**
 * @module integration/provider-capability-resolution.test
 * @description Tests für die Runtime-Capability-Projektion.
 */

import { describe, expect, it } from 'vitest';
import { resolveProviderCapabilities } from './provider-capability-resolution.js';
import type { DetectedStack, VerificationCandidate } from '../state/discovery-schemas.js';

function makeDetectedStack(
  items: Array<{ kind: string; id: string; evidence?: string }>,
): DetectedStack {
  return {
    summary: '',
    items: items.map((i) => ({
      kind: i.kind as DetectedStack['items'][number]['kind'],
      id: i.id,
      evidence: i.evidence,
    })),
    versions: [],
  };
}

function makeStructuredCandidate(
  providerId: string,
  format: string,
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
      format: format as never,
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
    const stack = makeDetectedStack([
      { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
    ]);
    const result = resolveProviderCapabilities(stack, undefined);
    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.detection.status).toBe('detected');
    expect(vitest.detection.evidence).toContain('testFramework:vitest via vitest.config.ts');
  });

  it('deduplicates multiple detection IDs to one provider entry', () => {
    const stack = makeDetectedStack([
      { kind: 'testFramework', id: 'go_test' },
      { kind: 'language', id: 'go' },
    ]);
    const result = resolveProviderCapabilities(stack, undefined);
    expect(result.filter((r) => r.providerId === 'go_test')).toHaveLength(1);
  });

  it('assertionBinding is available for registered codec providers', () => {
    const result = resolveProviderCapabilities(undefined, undefined);
    const junit = result.find((r) => r.providerId === 'junit')!;
    expect(junit.assertionBinding.status).toBe('available');
    expect(junit.assertionBinding.format).toBe('junit_xml');

    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.assertionBinding.status).toBe('available');
  });

  it('candidate is available when binding-compatible format exists', () => {
    const candidates = [
      makeStructuredCandidate('vitest', 'vitest_json', {
        source: 'detectedStack:testFramework:vitest',
      }),
    ];
    const result = resolveProviderCapabilities(undefined, candidates);
    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.candidate.status).toBe('available');
    expect(vitest.candidate.format).toBe('vitest_json');
  });

  it('candidate is unavailable when format is not binding-compatible', () => {
    const candidates = [makeStructuredCandidate('vitest', 'junit_xml')];
    const result = resolveProviderCapabilities(undefined, candidates);
    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.candidate.status).toBe('unavailable');
    expect(vitest.candidate.reason).toBe('format_not_binding_capable');
    expect(vitest.candidate.format).toBe('junit_xml');
  });

  it('pytest is available with pytest_json, unavailable with junit_xml', () => {
    const good = resolveProviderCapabilities(undefined, [
      makeStructuredCandidate('pytest', 'pytest_json'),
    ]);
    expect(good.find((r) => r.providerId === 'pytest')!.candidate.status).toBe('available');

    const bad = resolveProviderCapabilities(undefined, [
      makeStructuredCandidate('pytest', 'junit_xml'),
    ]);
    expect(bad.find((r) => r.providerId === 'pytest')!.candidate.status).toBe('unavailable');
    expect(bad.find((r) => r.providerId === 'pytest')!.candidate.reason).toBe(
      'format_not_binding_capable',
    );
  });

  it('candidate status unavailable when no matching candidate', () => {
    const result = resolveProviderCapabilities(undefined, undefined);
    const vitest = result.find((r) => r.providerId === 'vitest')!;
    expect(vitest.candidate.status).toBe('unavailable');
    expect(vitest.candidate.reason).toBe('no_structured_candidate');
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
