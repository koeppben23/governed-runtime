import { describe, it, expect } from 'vitest';

import { resolveHydrateIdentity } from './identity';
import { DEFAULT_CONFIG, type FlowGuardConfig } from '../config/flowguard-config';
import { createToolContext } from './test-helpers';
import { benchmarkSync } from '../test-policy';

describe('integration/identity', () => {
  const now = '2026-04-17T18:00:00.000Z';

  function config(overrides: Partial<FlowGuardConfig> = {}): FlowGuardConfig {
    return {
      ...DEFAULT_CONFIG,
      ...overrides,
      identity: {
        ...DEFAULT_CONFIG.identity,
        ...(overrides.identity ?? {}),
      },
      rbac: {
        ...DEFAULT_CONFIG.rbac,
        ...(overrides.rbac ?? {}),
      },
      risk: {
        ...DEFAULT_CONFIG.risk,
        ...(overrides.risk ?? {}),
      },
      archive: {
        ...DEFAULT_CONFIG.archive,
        ...(overrides.archive ?? {}),
      },
    };
  }

  describe('HAPPY', () => {
    it('accepts a valid strong OIDC assertion', () => {
      const context = createToolContext({
        sessionID: '7d0af0dd-6ca7-450f-b2f3-cc241fd0b4ea',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'oidc',
          assertedAt: now,
          assuranceLevel: 'strong',
          issuer: 'https://idp.example.com',
          sessionBindingId: '7d0af0dd-6ca7-450f-b2f3-cc241fd0b4ea',
        },
      });
      const result = resolveHydrateIdentity(
        context,
        config({
          identity: { ...DEFAULT_CONFIG.identity, allowedIssuers: ['https://idp.example.com'] },
        }),
        'regulated',
        now,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.assertion.identitySource).toBe('oidc');
        expect(result.value.source).toBe('host_assertion');
      }
    });

    it('uses local fallback for solo when no assertion is provided', () => {
      const context = createToolContext({ sessionID: 'c0502242-bafb-4f4d-97c7-bec775f0fa68' });
      const result = resolveHydrateIdentity(context, config(), 'solo', now);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('local_fallback');
        expect(result.value.assertion.identitySource).toBe('local');
      }
    });
  });

  describe('BAD', () => {
    it('blocks malformed assertion with IDENTITY_UNVERIFIED', () => {
      const context = createToolContext({ identityAssertion: { identitySource: 'oidc' } });
      const result = resolveHydrateIdentity(context, config(), 'regulated', now);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.blocked.code).toBe('IDENTITY_UNVERIFIED');
      }
    });

    it('blocks missing issuer for oidc with UNTRUSTED_IDENTITY_ISSUER', () => {
      const context = createToolContext({
        sessionID: '30ba4975-6d0c-4f7f-a0be-4ed1804f31a9',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'oidc',
          assertedAt: now,
          assuranceLevel: 'strong',
          sessionBindingId: '30ba4975-6d0c-4f7f-a0be-4ed1804f31a9',
        },
      });
      const result = resolveHydrateIdentity(context, config(), 'regulated', now);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.blocked.code).toBe('UNTRUSTED_IDENTITY_ISSUER');
      }
    });

    it('blocks unallowlisted issuer with UNTRUSTED_IDENTITY_ISSUER', () => {
      const context = createToolContext({
        sessionID: '02688b74-7d7d-4708-890f-7782cd3f8e79',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'oidc',
          assertedAt: now,
          assuranceLevel: 'strong',
          issuer: 'https://evil.example.com',
          sessionBindingId: '02688b74-7d7d-4708-890f-7782cd3f8e79',
        },
      });
      const result = resolveHydrateIdentity(
        context,
        config({
          identity: { ...DEFAULT_CONFIG.identity, allowedIssuers: ['https://idp.example.com'] },
        }),
        'regulated',
        now,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.blocked.code).toBe('UNTRUSTED_IDENTITY_ISSUER');
      }
    });

    it('blocks stale assertion with IDENTITY_UNVERIFIED', () => {
      const context = createToolContext({
        sessionID: '5b8a3c99-15a8-4d4f-ae43-f743f966ee72',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'oidc',
          assertedAt: '2026-04-17T17:30:00.000Z',
          assuranceLevel: 'strong',
          issuer: 'https://idp.example.com',
          sessionBindingId: '5b8a3c99-15a8-4d4f-ae43-f743f966ee72',
        },
      });
      const result = resolveHydrateIdentity(
        context,
        config({
          identity: {
            ...DEFAULT_CONFIG.identity,
            allowedIssuers: ['https://idp.example.com'],
            assertionMaxAgeSeconds: 60,
          },
        }),
        'regulated',
        now,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.blocked.code).toBe('IDENTITY_UNVERIFIED');
      }
    });

    it('blocks session binding mismatch with IDENTITY_UNVERIFIED', () => {
      const context = createToolContext({
        sessionID: '75f8ba66-5f46-4cc5-a6e2-fd55dc0d62c5',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'oidc',
          assertedAt: now,
          assuranceLevel: 'strong',
          issuer: 'https://idp.example.com',
          sessionBindingId: 'mismatch',
        },
      });
      const result = resolveHydrateIdentity(
        context,
        config({
          identity: { ...DEFAULT_CONFIG.identity, allowedIssuers: ['https://idp.example.com'] },
        }),
        'regulated',
        now,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.blocked.code).toBe('IDENTITY_UNVERIFIED');
      }
    });

    it('blocks local source in regulated mode with IDENTITY_SOURCE_NOT_ALLOWED', () => {
      const context = createToolContext({
        sessionID: '364d6dc7-f0af-405c-a3f2-c5b6af6a88f4',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'local',
          assertedAt: now,
          assuranceLevel: 'basic',
          sessionBindingId: '364d6dc7-f0af-405c-a3f2-c5b6af6a88f4',
        },
      });
      const result = resolveHydrateIdentity(context, config(), 'regulated', now);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.blocked.code).toBe('IDENTITY_SOURCE_NOT_ALLOWED');
      }
    });
  });

  describe('CORNER', () => {
    it('accepts oidc issuer when allowlist is empty in non-regulated mode', () => {
      const context = createToolContext({
        sessionID: 'c2d4ce7f-9538-43e7-9697-c65f836471df',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'oidc',
          assertedAt: now,
          assuranceLevel: 'strong',
          issuer: 'https://unknown-idp.example.com',
          sessionBindingId: 'c2d4ce7f-9538-43e7-9697-c65f836471df',
        },
      });
      const result = resolveHydrateIdentity(context, config(), 'team', now);

      expect(result.ok).toBe(true);
    });

    it('blocks oidc issuer with empty allowlist in regulated mode', () => {
      const context = createToolContext({
        sessionID: 'fdcb1b69-c8e0-49c8-b102-b3ddc169d58f',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'oidc',
          assertedAt: now,
          assuranceLevel: 'strong',
          issuer: 'https://idp.example.com',
          sessionBindingId: 'fdcb1b69-c8e0-49c8-b102-b3ddc169d58f',
        },
      });

      const result = resolveHydrateIdentity(context, config(), 'regulated', now);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.blocked.code).toBe('UNTRUSTED_IDENTITY_ISSUER');
      }
    });
  });

  describe('EDGE', () => {
    it('accepts hostContext.identityAssertion alias payload', () => {
      const context = createToolContext({
        sessionID: 'e1dc8d6c-9d8e-4436-ac1f-2a6c66570f3a',
        hostContext: {
          identityAssertion: {
            subjectId: 'alice',
            identitySource: 'oidc',
            assertedAt: now,
            assuranceLevel: 'strong',
            issuer: 'https://idp.example.com',
            sessionBindingId: 'e1dc8d6c-9d8e-4436-ac1f-2a6c66570f3a',
          },
        },
      });
      const result = resolveHydrateIdentity(
        context,
        config({
          identity: { ...DEFAULT_CONFIG.identity, allowedIssuers: ['https://idp.example.com'] },
        }),
        'regulated',
        now,
      );

      expect(result.ok).toBe(true);
    });
  });

  describe('PERF', () => {
    it('identity resolution p95 remains under 1ms', () => {
      const context = createToolContext({
        sessionID: '52f6e351-3290-43d0-88b6-7dad5536e4a7',
        identityAssertion: {
          subjectId: 'alice',
          identitySource: 'oidc',
          assertedAt: now,
          assuranceLevel: 'strong',
          issuer: 'https://idp.example.com',
          sessionBindingId: '52f6e351-3290-43d0-88b6-7dad5536e4a7',
        },
      });
      const cfg = config({
        identity: { ...DEFAULT_CONFIG.identity, allowedIssuers: ['https://idp.example.com'] },
      });
      const result = benchmarkSync(
        () => resolveHydrateIdentity(context, cfg, 'regulated', now),
        400,
        50,
      );
      expect(result.p95Ms).toBeLessThan(1);
    });
  });
});
