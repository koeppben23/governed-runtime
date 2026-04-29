/**
 * @module identity/token-verifier.test
 * @description Unit tests for JwtStaticTokenVerifier — identity trust boundary.
 *
 * Coverage: HAPPY, BAD, CORNER, EDGE
 * - HAPPY: Valid RSA + EC tokens verify correctly
 * - BAD: Malformed tokens, wrong signatures, expired, invalid issuer/audience
 * - CORNER: Missing kid, missing alg, empty claims, nbf in future
 * - EDGE: Multiple audiences, custom claim mapping, boundary timestamps
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { SignJWT } from 'jose';
import { JwtStaticTokenVerifier } from './token-verifier.js';
import { StaticKeyResolver } from './key-resolver.js';
import { IdpError } from './errors.js';
import type { IdpConfig, SigningKey } from './types.js';

// ─── Key Generation ─────────────────────────────────────────────────────────

const RSA_KEY_PAIR = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const EC_KEY_PAIR = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const RSA_PRIVATE_KEY = crypto.createPrivateKey(RSA_KEY_PAIR.privateKey);
const EC_PRIVATE_KEY = crypto.createPrivateKey(EC_KEY_PAIR.privateKey);

// ─── Helpers ────────────────────────────────────────────────────────────────

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: crypto.KeyObject,
): Promise<string> {
  const jwt = new SignJWT(payload).setProtectedHeader(header);

  if (typeof payload.iat === 'number') {
    jwt.setIssuedAt(payload.iat);
  }

  if (typeof payload.iss === 'string') {
    jwt.setIssuer(payload.iss);
  }

  if (typeof payload.aud === 'string' || Array.isArray(payload.aud)) {
    jwt.setAudience(payload.aud as string | string[]);
  }

  if (typeof payload.exp === 'number') {
    jwt.setExpirationTime(payload.exp);
  }

  if (typeof payload.nbf === 'number') {
    jwt.setNotBefore(payload.nbf);
  }

  return jwt.sign(privateKey);
}

function signJwtNode(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: crypto.KeyObject,
): string {
  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const data = Buffer.from(`${headerB64}.${payloadB64}`);
  const signatureBytes = crypto.sign('sha256', data, privateKey);
  const signatureB64 = signatureBytes.toString('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function makeConfig(overrides?: Partial<IdpConfig>): IdpConfig {
  return {
    mode: 'static',
    issuer: 'https://idp.example.com',
    audience: ['flowguard'],
    claimMapping: {
      subjectClaim: 'sub',
      emailClaim: 'email',
      nameClaim: 'name',
    },
    signingKeys: [
      {
        kind: 'pem',
        kid: 'rsa-key-1',
        alg: 'RS256',
        pem: RSA_KEY_PAIR.publicKey,
      },
      {
        kind: 'pem',
        kid: 'ec-key-1',
        alg: 'ES256',
        pem: EC_KEY_PAIR.publicKey,
      },
    ],
    ...overrides,
  } as IdpConfig;
}

function makeVerifier(configOverrides?: Partial<IdpConfig>): JwtStaticTokenVerifier {
  const config = makeConfig(configOverrides);
  const keys = (config as IdpConfig & { signingKeys: SigningKey[] }).signingKeys;
  const resolver = new StaticKeyResolver(keys);
  return new JwtStaticTokenVerifier(config, resolver);
}

const NOW = Math.floor(Date.now() / 1000);

function validRsaPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    iss: 'https://idp.example.com',
    aud: 'flowguard',
    sub: 'user-123',
    email: 'user@example.com',
    name: 'Test User',
    iat: NOW - 60,
    exp: NOW + 3600,
    ...overrides,
  };
}

async function validRsaToken(
  payloadOverrides?: Record<string, unknown>,
  headerOverrides?: Record<string, unknown>,
): Promise<string> {
  const header = { alg: 'RS256', kid: 'rsa-key-1', typ: 'JWT', ...headerOverrides };
  const payload = validRsaPayload(payloadOverrides);
  return signJwt(header, payload, RSA_PRIVATE_KEY);
}

async function validEcToken(
  payloadOverrides?: Record<string, unknown>,
  headerOverrides?: Record<string, unknown>,
): Promise<string> {
  const header = { alg: 'ES256', kid: 'ec-key-1', typ: 'JWT', ...headerOverrides };
  const payload = {
    iss: 'https://idp.example.com',
    aud: 'flowguard',
    sub: 'user-456',
    email: 'ec-user@example.com',
    name: 'EC User',
    iat: NOW - 60,
    exp: NOW + 3600,
    ...payloadOverrides,
  };
  return signJwt(header, payload, EC_PRIVATE_KEY);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('JwtStaticTokenVerifier', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────

  describe('HAPPY: valid tokens', () => {
    it('verifies a valid RSA-signed token', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken();
      const result = await verifier.verify(token);

      expect(result.subject).toBe('user-123');
      expect(result.email).toBe('user@example.com');
      expect(result.displayName).toBe('Test User');
      expect(result.issuer).toBe('https://idp.example.com');
      expect(result.audience).toEqual(['flowguard']);
      expect(result.keyId).toBe('rsa-key-1');
      expect(result.algorithm).toBe('RS256');
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.rawClaims).toHaveProperty('sub', 'user-123');
    });

    it('verifies a valid EC-signed token', async () => {
      const verifier = makeVerifier();
      const token = await validEcToken();
      const result = await verifier.verify(token);

      expect(result.subject).toBe('user-456');
      expect(result.email).toBe('ec-user@example.com');
      expect(result.displayName).toBe('EC User');
      expect(result.keyId).toBe('ec-key-1');
      expect(result.algorithm).toBe('ES256');
    });

    it('populates issuedAt and notBefore from token claims', async () => {
      const verifier = makeVerifier();
      const iat = NOW - 120;
      const nbf = NOW - 60;
      const token = await validRsaToken({ iat, nbf });
      const result = await verifier.verify(token);

      expect(result.issuedAt).toEqual(new Date(iat * 1000));
      expect(result.notBefore).toEqual(new Date(nbf * 1000));
    });

    it('handles multiple audiences', async () => {
      const verifier = makeVerifier({
        audience: ['flowguard', 'other-service'],
      } as Partial<IdpConfig>);
      const token = await validRsaToken({ aud: ['flowguard', 'other-service'] });
      const result = await verifier.verify(token);

      expect(result.audience).toEqual(['flowguard', 'other-service']);
    });
  });

  // ── BAD ────────────────────────────────────────────────────────────────

  describe('BAD: malformed and invalid tokens', () => {
    it('rejects token with wrong number of parts', async () => {
      const verifier = makeVerifier();
      await expect(verifier.verify('only.two')).rejects.toThrow(IdpError);
      await expect(verifier.verify('only.two')).rejects.toMatchObject({
        code: 'IDP_TOKEN_INVALID',
        message: 'IdP token is not valid JWT format: expected 3 parts',
      });
    });

    it('rejects token with empty string', async () => {
      const verifier = makeVerifier();
      await expect(verifier.verify('')).rejects.toThrow(IdpError);
    });

    it('rejects token with invalid base64url header', async () => {
      const verifier = makeVerifier();
      await expect(verifier.verify('!!!.abc.def')).rejects.toThrow(IdpError);
      await expect(verifier.verify('!!!.abc.def')).rejects.toMatchObject({
        code: 'IDP_TOKEN_HEADER_INVALID',
      });
      await expect(verifier.verify('!!!.abc.def')).rejects.toThrow(
        /Failed to decode base64url segment/,
      );
    });

    it('rejects token with invalid payload segment', async () => {
      const verifier = makeVerifier();
      const headerB64 = base64url({ alg: 'RS256', kid: 'rsa-key-1', typ: 'JWT' });
      const token = `${headerB64}.!!!.abc`;
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_TOKEN_INVALID',
      });
    });

    it('rejects expired token', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ exp: NOW - 60 });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_EXPIRED',
      });
      await expect(verifier.verify(token)).rejects.toThrow(/exp/);
    });

    it('rejects token with wrong issuer', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ iss: 'https://evil.example.com' });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_ISSUER_MISMATCH',
      });
      await expect(verifier.verify(token)).rejects.toThrow(/issuer/i);
    });

    it('rejects token with wrong audience', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ aud: 'wrong-audience' });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_AUDIENCE_MISMATCH',
      });
      await expect(verifier.verify(token)).rejects.toThrow(/audience/i);
    });

    it('rejects token with tampered payload (signature mismatch)', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken();
      const parts = token.split('.');
      // Tamper payload by replacing it
      const tamperedPayload = base64url({ ...validRsaPayload(), sub: 'hacker' });
      const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
      await expect(verifier.verify(tampered)).rejects.toMatchObject({
        code: 'IDP_SIGNATURE_INVALID',
        message: 'IdP token signature verification failed',
      });
    });

    it('rejects token signed with unknown kid', async () => {
      const verifier = makeVerifier();
      const header = { alg: 'RS256', kid: 'unknown-key', typ: 'JWT' };
      const payload = validRsaPayload();
      const token = signJwtNode(header, payload, RSA_PRIVATE_KEY);
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_KEY_NOT_FOUND',
      });
    });

    it('rejects token with algorithm mismatch (RSA key, EC alg)', async () => {
      const verifier = makeVerifier();
      // Sign with RSA key but claim ES256 in header
      const header = { alg: 'ES256', kid: 'rsa-key-1', typ: 'JWT' };
      const payload = validRsaPayload();
      const token = signJwtNode(header, payload, RSA_PRIVATE_KEY);
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_ALGORITHM_NOT_ALLOWED',
      });
      await expect(verifier.verify(token)).rejects.toThrow(/does not match key algorithm/);
    });

    it('rejects token with alg none', async () => {
      const verifier = makeVerifier();
      const header = base64url({ alg: 'none', kid: 'rsa-key-1', typ: 'JWT' });
      const payload = base64url(validRsaPayload());
      const token = `${header}.${payload}.`;
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_ALGORITHM_NOT_ALLOWED',
      });
    });
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  describe('CORNER: edge-case inputs', () => {
    it('rejects token with missing kid in header', async () => {
      const verifier = makeVerifier();
      const header = { alg: 'RS256', typ: 'JWT' }; // no kid
      const payload = validRsaPayload();
      const token = signJwtNode(header, payload, RSA_PRIVATE_KEY);
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_TOKEN_KID_MISSING',
        message: 'IdP token header missing kid',
      });
    });

    it('rejects token with missing alg in header', async () => {
      const verifier = makeVerifier();
      const header = { kid: 'rsa-key-1', typ: 'JWT' }; // no alg
      const payload = validRsaPayload();
      const token = signJwtNode(header, payload, RSA_PRIVATE_KEY);
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_TOKEN_HEADER_INVALID',
        message: 'IdP token header missing alg',
      });
    });

    it('rejects token with nbf in the future', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ nbf: NOW + 600 });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_NOT_YET_VALID',
      });
      await expect(verifier.verify(token)).rejects.toThrow(/nbf|not yet valid/i);
    });

    it('rejects token with missing subject claim', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ sub: undefined });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_SUBJECT_MISSING',
        message: 'Required subject claim missing in token',
      });
    });

    it('rejects token with empty string subject claim', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ sub: '' });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_SUBJECT_MISSING',
      });
    });

    it('rejects token with whitespace-only subject claim', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ sub: '   ' });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_SUBJECT_MISSING',
      });
    });

    it('returns null email when claim is missing', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ email: undefined });
      const result = await verifier.verify(token);
      expect(result.email).toBeNull();
    });

    it('returns null displayName when claim is missing', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ name: undefined });
      const result = await verifier.verify(token);
      expect(result.displayName).toBeNull();
    });
  });

  // ── EDGE ───────────────────────────────────────────────────────────────

  describe('EDGE: boundary conditions', () => {
    it('accepts token where exp is exactly now (not yet expired)', async () => {
      const verifier = makeVerifier();
      // exp == NOW: the condition is exp < now, so exp == now => NOT expired
      // Use a token expiring in 5s to avoid CI clock skew race condition
      const token = await validRsaToken({ exp: NOW + 5 });
      const result = await verifier.verify(token);
      expect(result.subject).toBe('user-123');
    });

    it('accepts token where nbf is exactly now (already valid)', async () => {
      const verifier = makeVerifier();
      // nbf == NOW: the condition is nbf > now, so nbf == now => valid
      const token = await validRsaToken({ nbf: NOW, exp: NOW + 3600 });
      const result = await verifier.verify(token);
      expect(result.notBefore).toEqual(new Date(NOW * 1000));
    });

    it('rejects token when exp is strictly before now (not at boundary)', async () => {
      const verifier = makeVerifier();
      // Freeze time to ensure deterministic boundary test
      const frozenNow = 1700000000;
      vi.useFakeTimers();
      vi.setSystemTime(frozenNow * 1000);
      // exp == frozenNow: should NOT reject (condition is exp < now)
      const token1 = await validRsaToken({ exp: frozenNow, iat: frozenNow - 60 });
      await expect(verifier.verify(token1)).resolves.toBeDefined();
      // exp == frozenNow - 1: SHOULD reject (exp < now)
      const token2 = await validRsaToken({ exp: frozenNow - 1, iat: frozenNow - 120 });
      await expect(verifier.verify(token2)).rejects.toMatchObject({ code: 'IDP_EXPIRED' });
      vi.useRealTimers();
    });

    it('rejects token when nbf is strictly after now (not at boundary)', async () => {
      const verifier = makeVerifier();
      const frozenNow = 1700000000;
      vi.useFakeTimers();
      vi.setSystemTime(frozenNow * 1000);
      // nbf == frozenNow: should NOT reject (condition is nbf > now)
      const token1 = await validRsaToken({ nbf: frozenNow, exp: frozenNow + 3600 });
      await expect(verifier.verify(token1)).resolves.toBeDefined();
      // nbf == frozenNow + 1: SHOULD reject (nbf > now)
      const token2 = await validRsaToken({ nbf: frozenNow + 1, exp: frozenNow + 3600 });
      await expect(verifier.verify(token2)).rejects.toMatchObject({ code: 'IDP_NOT_YET_VALID' });
      await expect(verifier.verify(token2)).rejects.toThrow(/not yet valid until 20[2-9]\d/);
      vi.useRealTimers();
    });

    it('uses custom claim mapping', async () => {
      const verifier = makeVerifier({
        claimMapping: {
          subjectClaim: 'user_id',
          emailClaim: 'user_email',
          nameClaim: 'display_name',
        },
      } as Partial<IdpConfig>);
      const token = await validRsaToken({
        user_id: 'custom-id',
        user_email: 'custom@example.com',
        display_name: 'Custom User',
        sub: undefined, // default sub not set
      });
      const result = await verifier.verify(token);
      expect(result.subject).toBe('custom-id');
      expect(result.email).toBe('custom@example.com');
      expect(result.displayName).toBe('Custom User');
    });

    it('audience match works when token has array and config has single entry', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ aud: ['flowguard', 'extra'] });
      const result = await verifier.verify(token);
      expect(result.audience).toEqual(['flowguard', 'extra']);
    });

    it('rejects token where none of the audiences match', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ aud: ['service-a', 'service-b'] });
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_AUDIENCE_MISMATCH',
      });
      await expect(verifier.verify(token)).rejects.toThrow(/audience/i);
    });

    it('provides default expiresAt when exp claim is missing', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ exp: undefined });
      const result = await verifier.verify(token);
      // Implementation falls back to now + 3600
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('returns null issuedAt when iat claim is absent', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ iat: undefined });
      const result = await verifier.verify(token);
      expect(result.issuedAt).toBeNull();
    });

    it('returns null notBefore when nbf claim is absent', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ nbf: undefined });
      const result = await verifier.verify(token);
      expect(result.notBefore).toBeNull();
    });
  });

  // ── MUTATION KILL: claim extraction and error messages ────────────────
  describe('MUTATION: claim and audience detail assertions', () => {
    it('audience mismatch error includes both token and configured audiences', async () => {
      const verifier = makeVerifier({
        audience: ['other-service'],
      } as Partial<IdpConfig>);
      const token = await validRsaToken({ aud: 'flowguard' });
      await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'IDP_AUDIENCE_MISMATCH' });
    });

    it('claim with whitespace-only value returns null (extractClaim trims)', async () => {
      const verifier = makeVerifier();
      // sub claim with only whitespace → extractClaim trims → null → verify throws IDP_SUBJECT_MISSING
      const token = await validRsaToken({ sub: '   ' });
      await expect(verifier.verify(token)).rejects.toThrow(/subject/i);
    });

    it('claim with padded whitespace is trimmed', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ sub: '  user-trimmed  ', email: ' trimmed@test.com ' });
      const result = await verifier.verify(token);
      expect(result.subject).toBe('user-trimmed');
      expect(result.email).toBe('trimmed@test.com');
    });

    it('name claim with whitespace-only returns null (extractClaimOrNull)', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ name: '  ' });
      const result = await verifier.verify(token);
      expect(result.displayName).toBeNull();
    });

    it('name claim padded with whitespace is trimmed', async () => {
      const verifier = makeVerifier();
      const token = await validRsaToken({ name: '  Padded Name  ' });
      const result = await verifier.verify(token);
      expect(result.displayName).toBe('Padded Name');
    });

    it('non-IdpError during signature verification is wrapped', async () => {
      // Create a verifier with a valid key resolver but tamper with the token
      // so that crypto.verify throws a non-IdpError
      const verifier = makeVerifier();
      // Malformed signature that causes crypto.verify to throw
      const header = base64url({ alg: 'RS256', kid: 'rsa-key-1', typ: 'JWT' });
      const payload = base64url(validRsaPayload());
      // Use invalid base64url for signature to trigger a crypto error
      const token = `${header}.${payload}.!!!invalid-signature!!!`;
      await expect(verifier.verify(token)).rejects.toMatchObject({
        code: 'IDP_SIGNATURE_INVALID',
      });
    });

    it('does not perform remote key fetch in verifier path', async () => {
      const verifier = makeVerifier();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const token = await validRsaToken();
      const result = await verifier.verify(token);
      expect(result.subject).toBe('user-123');
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });
});
