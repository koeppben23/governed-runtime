/**
 * @module identity/key-resolver
 * @description Key resolvers for P35a/P35b1/P35b2.
 *
 * Design: KeyResolver is separated from TokenVerifier for future extensibility.
 * P35a: StaticKeyResolver reads keys from policy config.
 * P35b1: JwksFileKeyResolver reads local pinned JWKS from filesystem.
 * P35b2: JwksRemoteKeyResolver fetches JWKS from HTTPS URI with TTL cache.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import type { JwksDocument, JwksKey, KeyAlgorithm, SigningKey } from './types.js';
import { JwksDocumentSchema } from './types.js';
import { IdpError } from './errors.js';

export interface ResolvedKey {
  key: crypto.KeyObject;
  kid: string;
  algorithm: KeyAlgorithm;
}

export interface KeyResolver {
  resolveKey(kid: string, tokenAlgorithm?: string): ResolvedKey;
  hasKey(kid: string): boolean;
  getKeyIds(): string[];
}

function importJwkKeySync(keyDef: SigningKey & { kind: 'jwk' }): crypto.KeyObject {
  const jwk = { ...keyDef.jwk, alg: keyDef.alg };
  return crypto.createPublicKey({ format: 'jwk', key: jwk });
}

function importPemKeySync(keyDef: SigningKey & { kind: 'pem' }): crypto.KeyObject {
  return crypto.createPublicKey(keyDef.pem);
}

/**
 * Static key resolver for P35a.
 * Uses Node.js crypto for synchronous key operations (no async import needed).
 */
export class StaticKeyResolver implements KeyResolver {
  private readonly keyMap: Map<string, ResolvedKey> = new Map();

  constructor(signingKeys: SigningKey[]) {
    for (const keyDef of signingKeys) {
      const key = keyDef.kind === 'pem' ? importPemKeySync(keyDef) : importJwkKeySync(keyDef);
      this.keyMap.set(keyDef.kid, { key, kid: keyDef.kid, algorithm: keyDef.alg });
    }
  }

  resolveKey(kid: string): ResolvedKey {
    const resolved = this.keyMap.get(kid);
    if (!resolved) {
      throw new IdpError(
        'IDP_KEY_NOT_FOUND',
        `Signing key with kid '${kid}' not found in IdP configuration`,
      );
    }
    return resolved;
  }

  hasKey(kid: string): boolean {
    return this.keyMap.has(kid);
  }

  getKeyIds(): string[] {
    return Array.from(this.keyMap.keys());
  }
}

function importJwksKeySync(keyDef: JwksKey): crypto.KeyObject {
  const keyMaterial =
    keyDef.kty === 'RSA'
      ? {
          kty: keyDef.kty,
          n: keyDef.n,
          e: keyDef.e,
          ...(keyDef.alg ? { alg: keyDef.alg } : {}),
        }
      : {
          kty: keyDef.kty,
          x: keyDef.x,
          y: keyDef.y,
          crv: keyDef.crv,
          ...(keyDef.alg ? { alg: keyDef.alg } : {}),
        };
  return crypto.createPublicKey({
    format: 'jwk',
    key: keyMaterial,
  });
}

function deriveAlgorithm(key: JwksKey): KeyAlgorithm {
  if (key.alg) {
    return key.alg;
  }
  return key.kty === 'RSA' ? 'RS256' : 'ES256';
}

export class JwksFileKeyResolver implements KeyResolver {
  private readonly keyMap: Map<string, ResolvedKey> = new Map();
  private readonly rawKeyMap: Map<string, JwksKey> = new Map();

  private constructor(doc: JwksDocument) {
    for (const keyDef of doc.keys) {
      let key: crypto.KeyObject;
      try {
        key = importJwksKeySync(keyDef);
      } catch (err) {
        throw new IdpError(
          'IDP_JWKS_INVALID',
          `JWKS key '${keyDef.kid}' cannot be imported: ${(err as Error).message}`,
        );
      }
      const algorithm = deriveAlgorithm(keyDef);
      this.keyMap.set(keyDef.kid, { key, kid: keyDef.kid, algorithm });
      this.rawKeyMap.set(keyDef.kid, keyDef);
    }
  }

  static async fromPath(jwksPath: string): Promise<JwksFileKeyResolver> {
    if (!jwksPath.trim()) {
      throw new IdpError('IDP_JWKS_PATH_MISSING', 'JWKS mode requires a non-empty jwksPath');
    }

    let raw: string;
    try {
      raw = await fs.readFile(jwksPath, 'utf-8');
    } catch (err) {
      throw new IdpError(
        'IDP_JWKS_READ_FAILED',
        `Cannot read JWKS file: ${(err as Error).message}`,
      );
    }

    const doc = parseJwksDocument(raw, 'JWKS file');
    return JwksFileKeyResolver.fromDocument(doc);
  }

  static fromDocument(doc: JwksDocument): JwksFileKeyResolver {
    return new JwksFileKeyResolver(doc);
  }

  resolveKey(kid: string, tokenAlgorithm?: string): ResolvedKey {
    const resolved = this.keyMap.get(kid);
    if (!resolved) {
      throw new IdpError('IDP_JWKS_KEY_NOT_FOUND', `No JWKS key found for kid '${kid}'`);
    }

    const raw = this.rawKeyMap.get(kid);
    if (raw?.alg && tokenAlgorithm && raw.alg !== tokenAlgorithm) {
      throw new IdpError(
        'IDP_JWKS_ALGORITHM_MISMATCH',
        `Token algorithm '${tokenAlgorithm}' does not match JWKS key algorithm '${raw.alg}'`,
      );
    }

    return resolved;
  }

  hasKey(kid: string): boolean {
    return this.keyMap.has(kid);
  }

  getKeyIds(): string[] {
    return Array.from(this.keyMap.keys());
  }
}

interface RemoteCacheEntry {
  readonly resolver: JwksFileKeyResolver;
  readonly expiresAtMs: number;
}

const remoteJwksCache: Map<string, RemoteCacheEntry> = new Map();

export class JwksRemoteKeyResolver {
  static async fromUri(jwksUri: string, cacheTtlSeconds: number): Promise<JwksFileKeyResolver> {
    const normalizedUri = normalizeJwksHttpsUri(jwksUri);
    const now = Date.now();
    const cached = remoteJwksCache.get(normalizedUri);
    if (cached && now < cached.expiresAtMs) {
      return cached.resolver;
    }

    const raw = await fetchJwksDocument(normalizedUri);
    const doc = parseJwksDocument(raw, 'JWKS URI response');
    const resolver = JwksFileKeyResolver.fromDocument(doc);
    remoteJwksCache.set(normalizedUri, {
      resolver,
      expiresAtMs: now + cacheTtlSeconds * 1000,
    });
    return resolver;
  }

  static clearCacheForTests(): void {
    remoteJwksCache.clear();
  }
}

function parseJwksDocument(raw: string, sourceLabel: string): JwksDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IdpError('IDP_JWKS_INVALID', `${sourceLabel} is not valid JSON`);
  }

  try {
    return JwksDocumentSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new IdpError('IDP_JWKS_INVALID', `JWKS schema validation failed: ${err.message}`);
    }
    throw err;
  }
}

function normalizeJwksHttpsUri(jwksUri: string): string {
  if (!jwksUri.trim()) {
    throw new IdpError('IDP_JWKS_URI_INVALID', 'JWKS mode requires a non-empty jwksUri');
  }
  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    throw new IdpError('IDP_JWKS_URI_INVALID', `Invalid JWKS URI: '${jwksUri}'`);
  }
  if (url.protocol !== 'https:') {
    throw new IdpError('IDP_JWKS_URI_INVALID', `JWKS URI must use https: '${jwksUri}'`);
  }
  return url.toString();
}

async function fetchJwksDocument(jwksUri: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(jwksUri, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new IdpError(
      'IDP_JWKS_FETCH_FAILED',
      `JWKS fetch failed for '${jwksUri}': ${(err as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new IdpError(
      'IDP_JWKS_FETCH_FAILED',
      `JWKS fetch returned HTTP ${response.status} for '${jwksUri}'`,
    );
  }
  return response.text();
}
