/**
 * @module providers/registry-validation.test
 * @description Tests for provider extension validation.
 */

import { describe, expect, it } from 'vitest';
import { validateProviderExtensions } from './registry-validation.js';
import { ASSERTION_PROVIDER_EXTENSIONS } from './registry.js';
import type { AssertionProviderExtension, ExecutionProfile } from './contract.js';

describe('validateProviderExtensions', () => {
  it('production extensions pass validation', () => {
    const errors = validateProviderExtensions(ASSERTION_PROVIDER_EXTENSIONS);
    expect(errors).toEqual([]);
  });

  it('detects duplicate providerId', () => {
    const ext: AssertionProviderExtension = {
      manifest: { providerId: 'vitest', label: 'Vitest' },
      discovery: { detectionIds: [], executionProfiles: [] },
      verification: { formats: [] },
    };
    const errors = validateProviderExtensions([...ASSERTION_PROVIDER_EXTENSIONS, ext]);
    expect(errors.some((e) => e.kind === 'duplicate_provider_id')).toBe(true);
  });

  it('detects codec provider mismatch', () => {
    const ext: AssertionProviderExtension = {
      manifest: { providerId: 'fake' as never, label: 'Fake' },
      discovery: { detectionIds: [], executionProfiles: [] },
      verification: {
        formats: [
          {
            format: 'fake_json' as never,
            parser: {
              format: 'fake_json' as never,
              parse: () => ({
                assertions: [],
                summary: {
                  assertionCount: 0,
                  passedCount: 0,
                  failedCount: 0,
                  erroredCount: 0,
                  skippedCount: 0,
                  suiteInfrastructureError: false,
                },
              }),
            },
            bindingCapability: 'assertion',
          },
        ],
        identityCodec: {
          providerId: 'wrong' as never,
          assertionBindingFormats: new Set(),
          buildLocalId: () => '',
          validateLocalId: () => true,
        },
      },
    };
    const errors = validateProviderExtensions([ext]);
    expect(errors.some((e) => e.kind === 'codec_provider_mismatch')).toBe(true);
  });

  it('detects script signature referencing unknown profile', () => {
    const profile: ExecutionProfile = {
      profileId: 'test-profile',
      providerId: 'unknown' as never,
      format: 'junit_xml' as never,
      kind: 'test' as const,
      priority: 0,
      assertionReport: {
        collection: 'snapshot_diff' as const,
        transport: 'file' as const,
        format: 'junit_xml' as never,
        providerId: 'unknown' as never,
        standardPatterns: [],
      },
      createCandidate: () => null,
    };
    const ext: AssertionProviderExtension = {
      manifest: { providerId: 'unknown' as never, label: 'Unknown' },
      discovery: {
        detectionIds: [],
        executionProfiles: [profile],
        scriptSignatures: [
          {
            executionProfileId: 'missing-profile',
            candidateKind: 'test',
            executable: 'unknown',
          },
        ],
      },
      verification: {
        formats: [
          {
            format: 'junit_xml' as never,
            parser: {
              format: 'junit_xml' as never,
              parse: () => ({
                assertions: [],
                summary: {
                  assertionCount: 0,
                  passedCount: 0,
                  failedCount: 0,
                  erroredCount: 0,
                  skippedCount: 0,
                  suiteInfrastructureError: false,
                },
              }),
            },
            bindingCapability: 'check_only',
          },
        ],
      },
    };
    const errors = validateProviderExtensions([ext]);
    expect(errors.some((e) => e.kind === 'signature_profile_missing')).toBe(true);
  });

  it('detects script signature kind mismatch with profile', () => {
    const profile: ExecutionProfile = {
      profileId: 'test-profile',
      providerId: 'unknown' as never,
      format: 'junit_xml' as never,
      kind: 'build' as const,
      priority: 0,
      assertionReport: {
        collection: 'snapshot_diff' as const,
        transport: 'file' as const,
        format: 'junit_xml' as never,
        providerId: 'unknown' as never,
        standardPatterns: [],
      },
      createCandidate: () => null,
    };
    const ext: AssertionProviderExtension = {
      manifest: { providerId: 'unknown' as never, label: 'Unknown' },
      discovery: {
        detectionIds: [],
        executionProfiles: [profile],
        scriptSignatures: [
          {
            executionProfileId: 'test-profile',
            candidateKind: 'test',
            executable: 'unknown',
          },
        ],
      },
      verification: {
        formats: [
          {
            format: 'junit_xml' as never,
            parser: {
              format: 'junit_xml' as never,
              parse: () => ({
                assertions: [],
                summary: {
                  assertionCount: 0,
                  passedCount: 0,
                  failedCount: 0,
                  erroredCount: 0,
                  skippedCount: 0,
                  suiteInfrastructureError: false,
                },
              }),
            },
            bindingCapability: 'check_only',
          },
        ],
      },
    };
    const errors = validateProviderExtensions([ext]);
    expect(errors.some((e) => e.kind === 'signature_kind_mismatch')).toBe(true);
  });

  it('detects profile assertionReport provider mismatch', () => {
    const profile: ExecutionProfile = {
      profileId: 'test-profile',
      providerId: 'pytest' as never,
      format: 'pytest_json' as never,
      kind: 'test' as const,
      priority: 0,
      assertionReport: {
        collection: 'run_specific' as const,
        transport: 'file' as const,
        format: 'pytest_json' as never,
        providerId: 'junit' as never,
        outputArgumentTemplate: '',
        resultPatternTemplate: '',
      },
      createCandidate: () => null,
    };
    const ext: AssertionProviderExtension = {
      manifest: { providerId: 'pytest' as never, label: 'PyTest' },
      discovery: { detectionIds: [], executionProfiles: [profile] },
      verification: {
        formats: [
          {
            format: 'pytest_json' as never,
            parser: {
              format: 'pytest_json' as never,
              parse: () => ({
                assertions: [],
                summary: {
                  assertionCount: 0,
                  passedCount: 0,
                  failedCount: 0,
                  erroredCount: 0,
                  skippedCount: 0,
                  suiteInfrastructureError: false,
                },
              }),
            },
            bindingCapability: 'assertion',
          },
        ],
      },
    };
    const errors = validateProviderExtensions([ext]);
    expect(errors.some((e) => e.kind === 'profile_report_provider_mismatch')).toBe(true);
  });

  it('detects profile assertionReport format mismatch', () => {
    const profile: ExecutionProfile = {
      profileId: 'test-profile',
      providerId: 'junit' as never,
      format: 'junit_xml' as never,
      kind: 'test' as const,
      priority: 0,
      assertionReport: {
        collection: 'run_specific' as const,
        transport: 'file' as const,
        format: 'pytest_json' as never,
        providerId: 'junit' as never,
        outputArgumentTemplate: '',
        resultPatternTemplate: '',
      },
      createCandidate: () => null,
    };
    const ext: AssertionProviderExtension = {
      manifest: { providerId: 'junit' as never, label: 'JUnit' },
      discovery: { detectionIds: [], executionProfiles: [profile] },
      verification: {
        formats: [
          {
            format: 'junit_xml' as never,
            parser: {
              format: 'junit_xml' as never,
              parse: () => ({
                assertions: [],
                summary: {
                  assertionCount: 0,
                  passedCount: 0,
                  failedCount: 0,
                  erroredCount: 0,
                  skippedCount: 0,
                  suiteInfrastructureError: false,
                },
              }),
            },
            bindingCapability: 'assertion',
          },
        ],
      },
    };
    const errors = validateProviderExtensions([ext]);
    expect(errors.some((e) => e.kind === 'profile_report_format_mismatch')).toBe(true);
  });

  it('detects profile assertionReport format not assertion-capable', () => {
    const profile: ExecutionProfile = {
      profileId: 'test-profile',
      providerId: 'junit' as never,
      format: 'junit_xml' as never,
      kind: 'test' as const,
      priority: 0,
      assertionReport: {
        collection: 'snapshot_diff' as const,
        transport: 'file' as const,
        format: 'junit_xml' as never,
        providerId: 'junit' as never,
        standardPatterns: [],
      },
      createCandidate: () => null,
    };
    const ext: AssertionProviderExtension = {
      manifest: { providerId: 'junit' as never, label: 'JUnit' },
      discovery: { detectionIds: [], executionProfiles: [profile] },
      verification: {
        formats: [
          {
            format: 'junit_xml' as never,
            parser: {
              format: 'junit_xml' as never,
              parse: () => ({
                assertions: [],
                summary: {
                  assertionCount: 0,
                  passedCount: 0,
                  failedCount: 0,
                  erroredCount: 0,
                  skippedCount: 0,
                  suiteInfrastructureError: false,
                },
              }),
            },
            bindingCapability: 'check_only',
          },
        ],
      },
    };
    const errors = validateProviderExtensions([ext]);
    expect(errors.some((e) => e.kind === 'profile_report_format_not_assertion_capable')).toBe(true);
  });
});
