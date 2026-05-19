/**
 * @module audit/tsa-provider
 * @description TSA provider and verifier interfaces with mock implementations.
 *
 * RFC 3161 Timestamp Authority integration:
 * - TimestampAuthorityProvider: sends a digest to a TSA, receives a DER-encoded
 *   TimeStampToken.
 * - TimestampVerifier: cryptographically verifies a TimeStampToken against
 *   trusted certificates.
 *
 * Slice 1 (#269): Interface + Mock implementations only.
 *   - MockTimestampAuthorityProvider: returns a pre-computed DER fixture token.
 *   - MockTimestampVerifier: checks fixture token against expected data.
 *   - MOCK_TSA_FIXTURE_TOKEN: mock token string for tests.
 *     Does NOT represent a verified RFC-3161 chain. Real verification requires
 *     a proper library (pkijs) in Slice 2.
 *
 * Slice 2 (follow-up ticket): PkijsTimestampVerifier with pkijs + asn1js,
 *   HttpTimestampAuthorityProvider, strict mode activation.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';

export interface TimestampAuthorityProvider {
  requestTimestamp(input: {
    digest: Uint8Array;
    digestAlgorithm: 'sha256';
    tsaUrl: string;
    timeoutMs: number;
  }): Promise<{
    tokenDerBase64: string;
    receivedAt: string;
  }>;
}

export interface TimestampVerifier {
  verifyToken(input: {
    tokenDerBase64: string;
    expectedDigest: Uint8Array;
    digestAlgorithm: 'sha256';
    trustAnchors: string[];
  }): Promise<{
    status: 'valid' | 'invalid';
    tsaTimestamp?: string;
    policyOid?: string;
    serialNumber?: string;
    signerSubject?: string;
    reason?: string;
  }>;
}

export const MOCK_TSA_FIXTURE_TOKEN = 'MOCK_TSA_TOKEN_NOT_REAL_RFC3161';

export class MockTimestampAuthorityProvider implements TimestampAuthorityProvider {
  private readonly tokenDerBase64: string;
  private readonly simulateFailure: boolean;

  constructor(opts?: { tokenDerBase64?: string; simulateFailure?: boolean }) {
    this.tokenDerBase64 = opts?.tokenDerBase64 ?? MOCK_TSA_FIXTURE_TOKEN;
    this.simulateFailure = opts?.simulateFailure ?? false;
  }

  async requestTimestamp(_input: {
    digest: Uint8Array;
    digestAlgorithm: 'sha256';
    tsaUrl: string;
    timeoutMs: number;
  }): Promise<{ tokenDerBase64: string; receivedAt: string }> {
    if (this.simulateFailure) {
      throw new Error('Mock TSA failure');
    }
    return {
      tokenDerBase64: this.tokenDerBase64,
      receivedAt: new Date().toISOString(),
    };
  }
}

export class MockTimestampVerifier implements TimestampVerifier {
  private readonly expectedToken: string;
  private readonly defaultStatus: 'valid' | 'invalid';
  private readonly failOnMismatch: boolean;

  constructor(opts?: {
    expectedToken?: string;
    defaultStatus?: 'valid' | 'invalid';
    failOnMismatch?: boolean;
  }) {
    this.expectedToken = opts?.expectedToken ?? MOCK_TSA_FIXTURE_TOKEN;
    this.defaultStatus = opts?.defaultStatus ?? 'valid';
    this.failOnMismatch = opts?.failOnMismatch ?? true;
  }

  async verifyToken(input: {
    tokenDerBase64: string;
    expectedDigest: Uint8Array;
    digestAlgorithm: 'sha256';
    trustAnchors: string[];
  }): Promise<{
    status: 'valid' | 'invalid';
    tsaTimestamp?: string;
    policyOid?: string;
    serialNumber?: string;
    signerSubject?: string;
    reason?: string;
  }> {
    if (this.failOnMismatch && input.tokenDerBase64 !== this.expectedToken) {
      return { status: 'invalid', reason: 'token_mismatch' };
    }
    return {
      status: this.defaultStatus,
      tsaTimestamp: new Date().toISOString(),
      policyOid: '1.3.6.1.4.1.4146.1.95',
      serialNumber: crypto.randomUUID(),
      signerSubject: 'CN=Mock TSA',
    };
  }
}
