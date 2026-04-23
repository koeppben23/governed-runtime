/**
 * @module identity/key-resolver
 * @description Static key resolver for P35a (no JWKS, no Remote Fetch).
 *
 * Design: KeyResolver is separated from TokenVerifier for future extensibility.
 * P35a: StaticKeyResolver reads keys from policy config.
 * Future (P35b/c): JwksKeyResolver fetches from remote endpoint.
 */

import * as crypto from 'node:crypto';
import type { KeyAlgorithm, SigningKey } from './types.js';
import { IdpError } from './errors.js';

export interface ResolvedKey {
  key: crypto.KeyObject;
  kid: string;
  algorithm: KeyAlgorithm;
}

export interface KeyResolver {
  resolveKey(kid: string): ResolvedKey;
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
