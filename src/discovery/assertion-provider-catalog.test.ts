/**
 * @module discovery/assertion-provider-catalog.test
 * @description Tests für den Assertion Provider Catalog.
 */

import { describe, expect, it } from 'vitest';
import {
  PROVIDER_DESCRIPTORS,
  DESCRIPTOR_BY_DETECTION,
  DESCRIPTOR_BY_PROVIDER,
  ASSERTION_PROFILES,
  type PlannerContext,
} from './assertion-provider-catalog.js';

describe('PROVIDER_DESCRIPTORS', () => {
  it('contains exactly 5 providers', () => {
    expect(PROVIDER_DESCRIPTORS).toHaveLength(5);
  });

  it('all providerIds are unique', () => {
    const ids = PROVIDER_DESCRIPTORS.map((d) => d.providerId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not include language:python as a detection ID', () => {
    for (const desc of PROVIDER_DESCRIPTORS) {
      expect(desc.detectionIds).not.toContain('language:python');
    }
  });

  it('go_test has two detection IDs', () => {
    const go = PROVIDER_DESCRIPTORS.find((d) => d.providerId === 'go_test');
    expect(go?.detectionIds).toContain('testFramework:go_test');
    expect(go?.detectionIds).toContain('language:go');
  });

  it('each provider has a distinct label', () => {
    const labels = PROVIDER_DESCRIPTORS.map((d) => d.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('DESCRIPTOR_BY_DETECTION maps all detection IDs', () => {
    for (const desc of PROVIDER_DESCRIPTORS) {
      for (const detId of desc.detectionIds) {
        expect(DESCRIPTOR_BY_DETECTION.get(detId)).toBe(desc);
      }
    }
  });

  it('DESCRIPTOR_BY_PROVIDER covers all descriptors', () => {
    for (const desc of PROVIDER_DESCRIPTORS) {
      expect(DESCRIPTOR_BY_PROVIDER.get(desc.providerId)).toBe(desc);
    }
    expect(DESCRIPTOR_BY_PROVIDER.size).toBe(PROVIDER_DESCRIPTORS.length);
  });
});

describe('Execution Profiles', () => {
  it('all profiles are present', () => {
    expect(ASSERTION_PROFILES).toHaveLength(6);
  });

  it('all profileIds are unique', () => {
    const ids = ASSERTION_PROFILES.map((p) => p.profileId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each profile references a known provider', () => {
    for (const p of ASSERTION_PROFILES) {
      expect(DESCRIPTOR_BY_PROVIDER.has(p.providerId)).toBe(true);
    }
  });

  it('go-test-stdout profile produces stdout collection', () => {
    const profile = ASSERTION_PROFILES.find((p) => p.profileId === 'go-test-stdout')!;
    const ctx: PlannerContext = {
      rootFiles: new Set(),
      packageManager: 'npm',
      detectedStackIds: new Set(['testFramework:go_test']),
    };
    const candidate = profile.createCandidate(ctx);
    expect(candidate?.assertionCapability).toBe('structured');
    const report = (candidate as Record<string, unknown>)?.assertionReport as
      Record<string, unknown> | undefined;
    expect(report?.collection).toBe('stdout');
    expect(report?.transport).toBe('stdout');
    expect(report?.outputArgumentTemplate).toBeUndefined();
    expect(report?.resultPatternTemplate).toBeUndefined();
    expect(report?.standardPatterns).toBeUndefined();
  });

  it('vitest fallback returns null when not detected', () => {
    const profile = ASSERTION_PROFILES.find((p) => p.profileId === 'vitest-fallback')!;
    const ctx: PlannerContext = {
      rootFiles: new Set(),
      packageManager: 'npm',
      detectedStackIds: new Set(),
    };
    expect(profile.createCandidate(ctx)).toBeNull();
  });

  it('maven wrapper returns null when mvnw not present', () => {
    const profile = ASSERTION_PROFILES.find((p) => p.profileId === 'junit-maven-wrapper')!;
    const ctx: PlannerContext = {
      rootFiles: new Set(),
      packageManager: 'npm',
      detectedStackIds: new Set(),
    };
    expect(profile.createCandidate(ctx)).toBeNull();
  });

  it('maven wrapper produces candidate when mvnw is present', () => {
    const profile = ASSERTION_PROFILES.find((p) => p.profileId === 'junit-maven-wrapper')!;
    const ctx: PlannerContext = {
      rootFiles: new Set(['mvnw']),
      packageManager: 'npm',
      detectedStackIds: new Set(),
    };
    const candidate = profile.createCandidate(ctx);
    expect(candidate).toBeDefined();
    expect(candidate?.command).toBe('./mvnw verify');
    expect(candidate?.assertionCapability).toBe('structured');
  });

  it('maven wrapper uses mvnw.cmd when only Windows wrapper exists', () => {
    const profile = ASSERTION_PROFILES.find((p) => p.profileId === 'junit-maven-wrapper')!;
    const ctx: PlannerContext = {
      rootFiles: new Set(['mvnw.cmd']),
      packageManager: 'npm',
      detectedStackIds: new Set(),
    };
    const candidate = profile.createCandidate(ctx);
    expect(candidate?.command).toBe('mvnw.cmd verify');
  });

  it('every runtime requirement probe command is read-only', () => {
    const installPatterns = [
      /\bnpm\s+install\b/,
      /\bnpm\s+i\b/,
      /\bpnpm\s+add\b/,
      /\byarn\s+add\b/,
      /\bpip\s+install\b/,
      /\bpip3\s+install\b/,
      /\bgo\s+install\b/,
      /\bgo\s+get\b/,
      /\bnpx\s+\S/,
    ];

    for (const desc of PROVIDER_DESCRIPTORS) {
      for (const req of desc.runtimeRequirements ?? []) {
        if (req.probe.kind !== 'exec') continue;
        for (const pattern of installPatterns) {
          expect(
            req.probe.command,
            `Provider '${desc.providerId}' runtime requirement '${req.id}' has install/network probe: ${req.probe.command}`,
          ).not.toMatch(pattern);
        }
      }
    }
  });
});
