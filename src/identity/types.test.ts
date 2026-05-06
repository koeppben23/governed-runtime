/**
 * @module identity/types.test
 * @description Tests for identity type schemas (JWK validation, private key rejection).
 *
 * Covers:
 * - JwkKeySchema: public RSA/EC acceptance, private key rejection
 * - SigningKeySchema: union validation
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect } from 'vitest';
import { JwkKeySchema, SigningKeySchema, type JwkKey } from './types.js';

// ─── Valid public JWKs ─────────────────────────────────────────────────────────

const validRsaJwk: JwkKey = {
  kind: 'jwk',
  kid: 'rsa-1',
  alg: 'RS256',
  jwk: {
    kty: 'RSA',
    n: 'modulus-base64url-string',
    e: 'AQAB',
  },
};

const validEcJwk: JwkKey = {
  kind: 'jwk',
  kid: 'ec-1',
  alg: 'ES256',
  jwk: {
    kty: 'EC',
    x: 'x-coordinate-base64url',
    y: 'y-coordinate-base64url',
    crv: 'P-256',
  },
};

// ─── HAPPY ─────────────────────────────────────────────────────────────────────

describe('JwkKeySchema', () => {
  describe('HAPPY', () => {
    it('accepts valid public RSA JWK', () => {
      const result = JwkKeySchema.safeParse(validRsaJwk);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.jwk.kty).toBe('RSA');
        expect(result.data.jwk.n).toBe('modulus-base64url-string');
        expect(result.data.jwk.e).toBe('AQAB');
      }
    });

    it('accepts valid public EC JWK', () => {
      const result = JwkKeySchema.safeParse(validEcJwk);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.jwk.kty).toBe('EC');
        expect(result.data.jwk.crv).toBe('P-256');
      }
    });

    it('accepts RSA JWK without optional EC fields', () => {
      const jwk = {
        kind: 'jwk' as const,
        kid: 'rsa-2',
        alg: 'RS256' as const,
        jwk: {
          kty: 'RSA' as const,
          n: 'n-value',
          e: 'AQAB',
        },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(true);
    });

    it('accepts EC JWK without optional RSA fields', () => {
      const jwk = {
        kind: 'jwk' as const,
        kid: 'ec-2',
        alg: 'ES256' as const,
        jwk: {
          kty: 'EC' as const,
          x: 'x-val',
          y: 'y-val',
          crv: 'P-256',
        },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(true);
    });
  });

  // ─── BAD ────────────────────────────────────────────────────────────────────

  describe('BAD', () => {
    it('rejects JWK with private exponent d (RSA)', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: { ...validRsaJwk.jwk, d: 'private-exponent' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects JWK with prime factor p (RSA)', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: { ...validRsaJwk.jwk, p: 'prime-factor-p' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects JWK with prime factor q (RSA)', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: { ...validRsaJwk.jwk, q: 'prime-factor-q' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects JWK with CRT exponent dp (RSA)', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: { ...validRsaJwk.jwk, dp: 'dp-value' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects JWK with CRT exponent dq (RSA)', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: { ...validRsaJwk.jwk, dq: 'dq-value' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects JWK with CRT coefficient qi (RSA)', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: { ...validRsaJwk.jwk, qi: 'qi-value' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects JWK with all private fields at once', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: {
          ...validRsaJwk.jwk,
          d: 'd',
          p: 'p',
          q: 'q',
          dp: 'dp',
          dq: 'dq',
          qi: 'qi',
        },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects EC JWK with injected private field d', () => {
      const jwk = {
        ...validEcJwk,
        jwk: { ...validEcJwk.jwk, d: 'ec-private-key' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects RS256 with EC key (alg ↔ kty mismatch)', () => {
      const jwk = {
        ...validEcJwk,
        alg: 'RS256' as const,
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects ES256 with RSA key (alg ↔ kty mismatch)', () => {
      const jwk = {
        ...validRsaJwk,
        alg: 'ES256' as const,
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('error message does not echo private key material', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: { ...validRsaJwk.jwk, d: 'super-secret-private-key-material' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
      if (!result.success) {
        const errStr = JSON.stringify(result.error.format());
        expect(errStr).not.toContain('super-secret-private-key-material');
      }
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────────

  describe('CORNER', () => {
    it('rejects empty JWK object', () => {
      const jwk = {
        kind: 'jwk' as const,
        kid: 'test',
        alg: 'RS256' as const,
        jwk: {},
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects JWK with unknown fields (strict mode)', () => {
      const jwk = {
        ...validRsaJwk,
        jwk: { ...validRsaJwk.jwk, unknownField: 'value' },
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });

    it('rejects top-level extra fields (strict mode)', () => {
      const jwk = {
        ...validRsaJwk,
        extraField: 'should-be-rejected',
      };
      const result = JwkKeySchema.safeParse(jwk);
      expect(result.success).toBe(false);
    });
  });
});

// ─── SigningKeySchema ──────────────────────────────────────────────────────────

describe('SigningKeySchema', () => {
  it('accepts PEM key', () => {
    const pemKey = {
      kind: 'pem' as const,
      kid: 'pem-1',
      alg: 'RS256' as const,
      pem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    };
    const result = SigningKeySchema.safeParse(pemKey);
    expect(result.success).toBe(true);
  });

  it('accepts valid JWK key', () => {
    const result = SigningKeySchema.safeParse(validRsaJwk);
    expect(result.success).toBe(true);
  });
});
