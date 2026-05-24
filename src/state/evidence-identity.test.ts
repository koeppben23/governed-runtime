/**
 * @module evidence-identity.test
 * @description Tests for evidence-identity module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  DecisionIdentity,
  ActorInfoSchema,
  ActorVerificationMetaSchema,
} from './evidence-identity.js';
import { FIXED_TIME } from './evidence-test-constants.js';

describe('evidence-identity', () => {
  describe('HAPPY', () => {
    it('DecisionIdentity parses minimal identity', () => {
      const identity = {
        actorId: 'user-1',
        actorEmail: 'user@example.com',
        actorSource: 'env' as const,
        actorAssurance: 'best_effort' as const,
      };
      expect(DecisionIdentity.parse(identity)).toEqual(identity);
    });

    it('DecisionIdentity defaults actorAssurance to best_effort', () => {
      const identity = {
        actorId: 'user-1',
        actorEmail: null,
        actorSource: 'git' as const,
      };
      expect(DecisionIdentity.parse(identity).actorAssurance).toBe('best_effort');
    });

    it('ActorInfoSchema parses full identity with verification meta', () => {
      const actor = {
        id: 'user-1',
        email: 'user@example.com',
        displayName: 'Test User',
        source: 'oidc' as const,
        assurance: 'idp_verified' as const,
        verificationMeta: {
          issuer: 'https://idp.example.com',
          audience: ['flowguard'],
          keyId: 'key-1',
          algorithm: 'RS256',
          verifiedAt: FIXED_TIME,
        },
      };
      expect(ActorInfoSchema.parse(actor)).toEqual(actor);
    });

    it('ActorVerificationMetaSchema parses valid metadata', () => {
      const meta = {
        issuer: 'https://auth.example.com',
        audience: ['flowguard'],
        keyId: 'kid-1',
        algorithm: 'ES256',
        verifiedAt: FIXED_TIME,
      };
      expect(ActorVerificationMetaSchema.parse(meta)).toEqual(meta);
    });
  });

  describe('BAD', () => {
    it('DecisionIdentity rejects empty actorId', () => {
      expect(() =>
        DecisionIdentity.parse({
          actorId: '',
          actorEmail: null,
          actorSource: 'env',
        }),
      ).toThrow();
    });

    it('DecisionIdentity rejects invalid actorSource', () => {
      expect(() =>
        DecisionIdentity.parse({
          actorId: 'user',
          actorEmail: null,
          actorSource: 'invalid',
        }),
      ).toThrow();
    });

    it('ActorInfoSchema rejects empty id', () => {
      expect(() =>
        ActorInfoSchema.parse({
          id: '',
          email: null,
          source: 'env',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('DecisionIdentity actorDisplayName is optional', () => {
      const identity = {
        actorId: 'user-1',
        actorEmail: null,
        actorSource: 'env' as const,
      };
      expect(DecisionIdentity.parse(identity)).toMatchObject(identity);
    });

    it('ActorInfoSchema verificationMeta is optional', () => {
      const actor = {
        id: 'user-1',
        email: null,
        source: 'env' as const,
      };
      expect(ActorInfoSchema.parse(actor)).toMatchObject(actor);
    });
  });

  describe('EDGE', () => {
    it('DecisionIdentity rejects null actorId (must be min(1))', () => {
      expect(() =>
        DecisionIdentity.parse({
          actorId: null,
          actorEmail: null,
          actorSource: 'env',
        }),
      ).toThrow();
    });

    it('ActorVerificationMeta rejects missing issuer', () => {
      expect(() =>
        ActorVerificationMetaSchema.parse({
          audience: ['flowguard'],
          keyId: 'k',
          algorithm: 'RS256',
          verifiedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });
});
