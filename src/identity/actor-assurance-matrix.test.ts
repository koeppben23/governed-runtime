import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

import { executeReviewDecision } from '../rails/review-decision.js';
import { resolvePolicy } from '../config/policy.js';
import { resolveActorForPolicy } from '../adapters/actor-context.js';
import { makeProgressedState } from '../__fixtures__.js';

type RequiredTier = 'best_effort' | 'claim_validated' | 'idp_verified';
type ActualTier = 'best_effort' | 'claim_validated' | 'idp_verified' | 'unknown';

const NOW = '2026-04-29T00:00:00.000Z';

function makeDecisionInput(actual: ActualTier) {
  return {
    verdict: 'approve' as const,
    rationale: 'matrix enforcement',
    decidedBy: 'reviewer-1',
    decisionIdentity: {
      actorId: 'reviewer-1',
      actorEmail: 'reviewer@example.com',
      actorSource: actual === 'unknown' ? ('unknown' as const) : ('claim' as const),
      actorAssurance:
        actual === 'unknown'
          ? ('unknown' as unknown as 'best_effort' | 'claim_validated' | 'idp_verified')
          : actual,
    },
  };
}

describe('actor assurance matrix', () => {
  describe('HAPPY/BAD/CORNER — required x actual matrix via decision enforcement', () => {
    const requiredTiers: RequiredTier[] = ['best_effort', 'claim_validated', 'idp_verified'];
    const actualTiers: ActualTier[] = ['best_effort', 'claim_validated', 'idp_verified', 'unknown'];

    const expected: Record<RequiredTier, Record<ActualTier, 'allow' | 'block'>> = {
      best_effort: {
        best_effort: 'allow',
        claim_validated: 'allow',
        idp_verified: 'allow',
        unknown: 'block',
      },
      claim_validated: {
        best_effort: 'block',
        claim_validated: 'allow',
        idp_verified: 'allow',
        unknown: 'block',
      },
      idp_verified: {
        best_effort: 'block',
        claim_validated: 'block',
        idp_verified: 'allow',
        unknown: 'block',
      },
    };

    for (const required of requiredTiers) {
      for (const actual of actualTiers) {
        it(`required=${required}, actual=${actual} -> ${expected[required][actual]}`, () => {
          const state = makeProgressedState('PLAN_REVIEW');
          const result = executeReviewDecision(state, makeDecisionInput(actual), {
            now: () => NOW,
            digest: (text) => text,
            policy: {
              ...resolvePolicy('regulated'),
              allowSelfApproval: false,
              minimumActorAssuranceForApproval: required,
              requireVerifiedActorsForApproval: false,
            },
          });

          if (expected[required][actual] === 'allow') {
            expect(result.kind).toBe('ok');
          } else {
            expect(result.kind).toBe('blocked');
            if (result.kind === 'blocked' && actual === 'unknown') {
              expect(result.code).toBe('REGULATED_ACTOR_UNKNOWN');
            }
            if (result.kind === 'blocked' && actual !== 'unknown') {
              expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
            }
          }
        });
      }
    }
  });

  describe('EDGE/E2E-SMOKE — policy-aware actor resolution (IdP mode)', () => {
    const envBackup: Record<string, string | undefined> = {};
    const ENV_KEYS = [
      'FLOWGUARD_ACTOR_TOKEN_PATH',
      'FLOWGUARD_ACTOR_ID',
      'FLOWGUARD_ACTOR_CLAIMS_PATH',
    ];

    beforeEach(() => {
      for (const key of ENV_KEYS) {
        envBackup[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (envBackup[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = envBackup[key];
        }
      }
    });

    it('required + missing config -> block', async () => {
      const policy = {
        ...resolvePolicy('regulated'),
        identityProviderMode: 'required' as const,
        identityProvider: undefined,
      };
      await expect(resolveActorForPolicy('/tmp/worktree', policy)).rejects.toMatchObject({
        code: 'ACTOR_IDP_CONFIG_REQUIRED',
      });
    });

    it('required + invalid config {} -> block', async () => {
      const policy = {
        ...resolvePolicy('regulated'),
        identityProviderMode: 'required' as const,
        identityProvider: {} as never,
      };
      await expect(resolveActorForPolicy('/tmp/worktree', policy)).rejects.toMatchObject({
        code: 'ACTOR_IDP_CONFIG_REQUIRED',
      });
    });

    it('required + no token -> block', async () => {
      const policy = {
        ...resolvePolicy('regulated'),
        identityProviderMode: 'required' as const,
        identityProvider: {
          mode: 'static' as const,
          issuer: 'https://issuer.example.com',
          audience: 'flowguard',
          claimMapping: {
            subjectClaim: 'sub',
            emailClaim: 'email',
            nameClaim: 'name',
          },
          signingKeys: [
            {
              kind: 'jwk' as const,
              kid: 'k1',
              alg: 'RS256' as const,
              jwk: { kty: 'RSA' as const, n: 'abc', e: 'AQAB' },
            },
          ],
        },
      };
      await expect(resolveActorForPolicy('/tmp/worktree', policy)).rejects.toMatchObject({
        code: 'ACTOR_IDP_MODE_REQUIRED',
      });
    });

    it('optional + no token -> fallback allowed, not idp_verified', async () => {
      process.env.FLOWGUARD_ACTOR_ID = 'fallback-user';
      const policy = {
        ...resolvePolicy('team'),
        identityProviderMode: 'optional' as const,
        identityProvider: {
          mode: 'static' as const,
          issuer: 'https://issuer.example.com',
          audience: 'flowguard',
          claimMapping: {
            subjectClaim: 'sub',
            emailClaim: 'email',
            nameClaim: 'name',
          },
          signingKeys: [
            {
              kind: 'jwk' as const,
              kid: 'k1',
              alg: 'RS256' as const,
              jwk: { kty: 'RSA' as const, n: 'abc', e: 'AQAB' },
            },
          ],
        },
      };

      const actor = await resolveActorForPolicy('/tmp/worktree', policy);
      expect(actor.assurance).toBe('best_effort');
      expect(actor.source).toBe('env');
    });

    it('required + valid token -> idp_verified', async () => {
      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const jwk = await exportJWK(publicKey);
      const kid = 'matrix-kid-1';
      const issuer = 'https://issuer.example.com';
      const audience = 'flowguard';
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        sub: 'idp-user-1',
        email: 'idp@example.com',
        name: 'IdP User',
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(now)
        .setNotBefore(now - 1)
        .setExpirationTime(now + 3600)
        .sign(privateKey);

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-idp-matrix-'));
      const tokenPath = path.join(tmpDir, `${crypto.randomUUID()}.jwt`);
      await fs.writeFile(tokenPath, token, 'utf-8');
      process.env.FLOWGUARD_ACTOR_TOKEN_PATH = tokenPath;

      const policy = {
        ...resolvePolicy('regulated'),
        identityProviderMode: 'required' as const,
        identityProvider: {
          mode: 'static' as const,
          issuer,
          audience,
          claimMapping: {
            subjectClaim: 'sub',
            emailClaim: 'email',
            nameClaim: 'name',
          },
          signingKeys: [
            {
              kind: 'jwk' as const,
              kid,
              alg: 'RS256' as const,
              jwk: jwk as {
                kty: 'RSA';
                n: string;
                e: string;
                d?: string;
                p?: string;
                q?: string;
                dp?: string;
                dq?: string;
                qi?: string;
                x?: string;
                y?: string;
                crv?: string;
              },
            },
          ],
        },
      };

      try {
        const actor = await resolveActorForPolicy('/tmp/worktree', policy);
        expect(actor.assurance).toBe('idp_verified');
        expect(actor.source).toBe('oidc');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
