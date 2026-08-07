/**
 * @module providers/registry-validation.test
 * @description Tests for provider extension validation.
 */

import { describe, expect, it } from 'vitest';
import { validateProviderExtensions } from './registry-validation.js';
import { ASSERTION_PROVIDER_EXTENSIONS } from './registry.js';
import type { AssertionProviderExtension } from './contract.js';

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
});
