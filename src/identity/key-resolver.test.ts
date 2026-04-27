/**
 * @module identity/key-resolver.test
 * @description Unit tests for StaticKeyResolver and JwksFileKeyResolver — identity trust boundary.
 *
 * Coverage: HAPPY, BAD, CORNER, EDGE
 * - HAPPY: Resolve keys by kid, list key IDs
 * - BAD: Unknown kid, invalid keys, invalid JWKS document
 * - CORNER: Empty JWKS, single-key resolver, PEM vs JWK
 * - EDGE: Algorithm mismatch in JWKS, multiple keys with same algorithm
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StaticKeyResolver, JwksFileKeyResolver, JwksRemoteKeyResolver } from './key-resolver.js';
import { IdpError } from './errors.js';
import type { SigningKey, JwksDocument } from './types.js';

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

// Export RSA public key as JWK for JWKS tests
const RSA_PUBLIC_KEY_OBJ = crypto.createPublicKey(RSA_KEY_PAIR.publicKey);
const RSA_JWK = RSA_PUBLIC_KEY_OBJ.export({ format: 'jwk' }) as Record<string, string>;

const EC_PUBLIC_KEY_OBJ = crypto.createPublicKey(EC_KEY_PAIR.publicKey);
const EC_JWK = EC_PUBLIC_KEY_OBJ.export({ format: 'jwk' }) as Record<string, string>;

// ─── StaticKeyResolver Tests ────────────────────────────────────────────────

describe('StaticKeyResolver', () => {
  const pemKeys: SigningKey[] = [
    { kind: 'pem', kid: 'rsa-1', alg: 'RS256', pem: RSA_KEY_PAIR.publicKey },
    { kind: 'pem', kid: 'ec-1', alg: 'ES256', pem: EC_KEY_PAIR.publicKey },
  ];

  describe('HAPPY: valid key resolution', () => {
    it('resolves RSA key by kid', () => {
      const resolver = new StaticKeyResolver(pemKeys);
      const resolved = resolver.resolveKey('rsa-1');
      expect(resolved.kid).toBe('rsa-1');
      expect(resolved.algorithm).toBe('RS256');
      expect(resolved.key.asymmetricKeyType).toBe('rsa');
    });

    it('resolves EC key by kid', () => {
      const resolver = new StaticKeyResolver(pemKeys);
      const resolved = resolver.resolveKey('ec-1');
      expect(resolved.kid).toBe('ec-1');
      expect(resolved.algorithm).toBe('ES256');
      expect(resolved.key.asymmetricKeyType).toBe('ec');
    });

    it('hasKey returns true for known kid', () => {
      const resolver = new StaticKeyResolver(pemKeys);
      expect(resolver.hasKey('rsa-1')).toBe(true);
      expect(resolver.hasKey('ec-1')).toBe(true);
    });

    it('getKeyIds returns all configured key IDs', () => {
      const resolver = new StaticKeyResolver(pemKeys);
      expect(resolver.getKeyIds()).toEqual(['rsa-1', 'ec-1']);
    });
  });

  describe('BAD: unknown or invalid keys', () => {
    it('throws IDP_KEY_NOT_FOUND for unknown kid', () => {
      const resolver = new StaticKeyResolver(pemKeys);
      expect(() => resolver.resolveKey('unknown-key')).toThrow(IdpError);
      expect(() => resolver.resolveKey('unknown-key')).toThrow('unknown-key');
    });

    it('hasKey returns false for unknown kid', () => {
      const resolver = new StaticKeyResolver(pemKeys);
      expect(resolver.hasKey('nonexistent')).toBe(false);
    });
  });

  describe('CORNER: single key and JWK kind', () => {
    it('works with a single PEM key', () => {
      const resolver = new StaticKeyResolver([pemKeys[0]!]);
      expect(resolver.getKeyIds()).toEqual(['rsa-1']);
      expect(resolver.resolveKey('rsa-1').algorithm).toBe('RS256');
    });

    it('works with JWK kind key', () => {
      const jwkKey: SigningKey = {
        kind: 'jwk',
        kid: 'jwk-rsa-1',
        alg: 'RS256',
        jwk: {
          kty: 'RSA' as const,
          n: RSA_JWK.n,
          e: RSA_JWK.e,
        },
      };
      const resolver = new StaticKeyResolver([jwkKey]);
      const resolved = resolver.resolveKey('jwk-rsa-1');
      expect(resolved.kid).toBe('jwk-rsa-1');
      expect(resolved.algorithm).toBe('RS256');
    });

    it('returns empty array for no keys', () => {
      const resolver = new StaticKeyResolver([]);
      expect(resolver.getKeyIds()).toEqual([]);
    });
  });
});

// ─── JwksFileKeyResolver Tests ──────────────────────────────────────────────

describe('JwksFileKeyResolver', () => {
  function makeJwksDoc(keys: Array<Record<string, unknown>>): JwksDocument {
    return { keys } as JwksDocument;
  }

  const rsaJwksKey = {
    kid: 'jwks-rsa-1',
    kty: 'RSA' as const,
    n: RSA_JWK.n!,
    e: RSA_JWK.e!,
  };

  const ecJwksKey = {
    kid: 'jwks-ec-1',
    kty: 'EC' as const,
    x: EC_JWK.x!,
    y: EC_JWK.y!,
    crv: EC_JWK.crv!,
  };

  describe('HAPPY: valid JWKS resolution', () => {
    it('resolves RSA key from JWKS document', () => {
      const doc: JwksDocument = { keys: [rsaJwksKey] };
      const resolver = JwksFileKeyResolver.fromDocument(doc);
      const resolved = resolver.resolveKey('jwks-rsa-1');
      expect(resolved.kid).toBe('jwks-rsa-1');
      // RSA without explicit alg defaults to RS256
      expect(resolved.algorithm).toBe('RS256');
    });

    it('resolves EC key from JWKS document', () => {
      const doc: JwksDocument = { keys: [ecJwksKey] };
      const resolver = JwksFileKeyResolver.fromDocument(doc);
      const resolved = resolver.resolveKey('jwks-ec-1');
      expect(resolved.kid).toBe('jwks-ec-1');
      // EC without explicit alg defaults to ES256
      expect(resolved.algorithm).toBe('ES256');
    });

    it('resolves from file path', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-jwks-'));
      const jwksPath = path.join(tmpDir, 'keys.json');
      const doc: JwksDocument = { keys: [rsaJwksKey] };
      await fs.writeFile(jwksPath, JSON.stringify(doc));

      try {
        const resolver = await JwksFileKeyResolver.fromPath(jwksPath);
        const resolved = resolver.resolveKey('jwks-rsa-1');
        expect(resolved.kid).toBe('jwks-rsa-1');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('lists all key IDs from JWKS document', () => {
      const doc: JwksDocument = { keys: [rsaJwksKey, ecJwksKey] };
      const resolver = JwksFileKeyResolver.fromDocument(doc);
      expect(resolver.getKeyIds()).toEqual(['jwks-rsa-1', 'jwks-ec-1']);
    });
  });

  describe('BAD: invalid JWKS inputs', () => {
    it('throws for unknown kid', () => {
      const doc: JwksDocument = { keys: [rsaJwksKey] };
      const resolver = JwksFileKeyResolver.fromDocument(doc);
      expect(() => resolver.resolveKey('nonexistent')).toThrow(IdpError);
    });

    it('throws IDP_JWKS_PATH_MISSING for empty path', async () => {
      await expect(JwksFileKeyResolver.fromPath('')).rejects.toMatchObject({
        code: 'IDP_JWKS_PATH_MISSING',
      });
    });

    it('throws IDP_JWKS_PATH_MISSING for whitespace-only path', async () => {
      await expect(JwksFileKeyResolver.fromPath('   ')).rejects.toMatchObject({
        code: 'IDP_JWKS_PATH_MISSING',
      });
    });

    it('throws IDP_JWKS_READ_FAILED for nonexistent file', async () => {
      await expect(JwksFileKeyResolver.fromPath('/nonexistent/path.json')).rejects.toMatchObject({
        code: 'IDP_JWKS_READ_FAILED',
      });
    });

    it('throws IDP_JWKS_INVALID for non-JSON file', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-jwks-'));
      const jwksPath = path.join(tmpDir, 'bad.json');
      await fs.writeFile(jwksPath, 'not json');

      try {
        await expect(JwksFileKeyResolver.fromPath(jwksPath)).rejects.toMatchObject({
          code: 'IDP_JWKS_INVALID',
        });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws IDP_JWKS_INVALID for JWKS with no keys array', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-jwks-'));
      const jwksPath = path.join(tmpDir, 'empty.json');
      await fs.writeFile(jwksPath, JSON.stringify({ keys: [] }));

      try {
        await expect(JwksFileKeyResolver.fromPath(jwksPath)).rejects.toMatchObject({
          code: 'IDP_JWKS_INVALID',
        });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('EDGE: algorithm mismatch detection', () => {
    it('throws IDP_JWKS_ALGORITHM_MISMATCH when token alg differs from JWKS key alg', () => {
      const keyWithAlg = { ...rsaJwksKey, alg: 'RS256' as const };
      const doc: JwksDocument = { keys: [keyWithAlg] };
      const resolver = JwksFileKeyResolver.fromDocument(doc);
      // Token claims ES256 but JWKS key is RS256
      expect(() => resolver.resolveKey('jwks-rsa-1', 'ES256')).toThrow(IdpError);
      expect(() => resolver.resolveKey('jwks-rsa-1', 'ES256')).toThrow('algorithm');
    });

    it('allows matching algorithm', () => {
      const keyWithAlg = { ...rsaJwksKey, alg: 'RS256' as const };
      const doc: JwksDocument = { keys: [keyWithAlg] };
      const resolver = JwksFileKeyResolver.fromDocument(doc);
      const resolved = resolver.resolveKey('jwks-rsa-1', 'RS256');
      expect(resolved.kid).toBe('jwks-rsa-1');
    });

    it('skips algorithm check when JWKS key has no explicit alg', () => {
      const doc: JwksDocument = { keys: [rsaJwksKey] }; // no alg on key
      const resolver = JwksFileKeyResolver.fromDocument(doc);
      // Should not throw even with mismatched token alg
      const resolved = resolver.resolveKey('jwks-rsa-1', 'ES256');
      expect(resolved.kid).toBe('jwks-rsa-1');
    });
  });
});

// ─── JwksRemoteKeyResolver Tests ────────────────────────────────────────────

describe('JwksRemoteKeyResolver', () => {
  describe('BAD: invalid URI', () => {
    it('rejects non-https URI', async () => {
      await expect(
        JwksRemoteKeyResolver.fromUri('http://insecure.example.com/.well-known/jwks.json', 300),
      ).rejects.toMatchObject({
        code: 'IDP_JWKS_URI_INVALID',
      });
    });

    it('rejects empty URI', async () => {
      await expect(JwksRemoteKeyResolver.fromUri('', 300)).rejects.toMatchObject({
        code: 'IDP_JWKS_URI_INVALID',
      });
    });

    it('rejects malformed URI', async () => {
      await expect(JwksRemoteKeyResolver.fromUri('not-a-url', 300)).rejects.toMatchObject({
        code: 'IDP_JWKS_URI_INVALID',
      });
    });
  });
});
