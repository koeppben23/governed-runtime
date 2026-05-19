import { describe, it, expect } from 'vitest';
import {
  MockTimestampAuthorityProvider,
  MockTimestampVerifier,
  FIXTURE_DER_TOKEN_FOR_MOCK_VERIFIER,
} from './tsa-provider.js';

describe('MockTimestampAuthorityProvider', () => {
  it('returns a mock token with fixture data', async () => {
    const provider = new MockTimestampAuthorityProvider();
    const result = await provider.requestTimestamp({
      digest: new Uint8Array(32),
      digestAlgorithm: 'sha256',
      tsaUrl: 'https://tsa.example.com',
      timeoutMs: 5000,
    });
    expect(result.tokenDerBase64).toBe(FIXTURE_DER_TOKEN_FOR_MOCK_VERIFIER);
    expect(result.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('uses custom token when provided', async () => {
    const provider = new MockTimestampAuthorityProvider({ tokenDerBase64: 'custom_token' });
    const result = await provider.requestTimestamp({
      digest: new Uint8Array(32),
      digestAlgorithm: 'sha256',
      tsaUrl: '',
      timeoutMs: 5000,
    });
    expect(result.tokenDerBase64).toBe('custom_token');
  });

  it('throws when simulateFailure is true', async () => {
    const provider = new MockTimestampAuthorityProvider({ simulateFailure: true });
    await expect(
      provider.requestTimestamp({
        digest: new Uint8Array(32),
        digestAlgorithm: 'sha256',
        tsaUrl: '',
        timeoutMs: 5000,
      }),
    ).rejects.toThrow('Mock TSA failure');
  });
});

describe('MockTimestampVerifier', () => {
  it('returns valid status for matching token', async () => {
    const verifier = new MockTimestampVerifier();
    const result = await verifier.verifyToken({
      tokenDerBase64: FIXTURE_DER_TOKEN_FOR_MOCK_VERIFIER,
      expectedDigest: new Uint8Array(32),
      digestAlgorithm: 'sha256',
      trustAnchors: [],
    });
    expect(result.status).toBe('valid');
    expect(result.tsaTimestamp).toBeDefined();
    expect(result.policyOid).toBeDefined();
    expect(result.serialNumber).toBeDefined();
    expect(result.signerSubject).toBe('CN=Mock TSA');
  });

  it('returns invalid status for mismatched token', async () => {
    const verifier = new MockTimestampVerifier();
    const result = await verifier.verifyToken({
      tokenDerBase64: 'different_token',
      expectedDigest: new Uint8Array(32),
      digestAlgorithm: 'sha256',
      trustAnchors: [],
    });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('token_mismatch');
  });

  it('returns configurable default status', async () => {
    const verifier = new MockTimestampVerifier({ defaultStatus: 'invalid', failOnMismatch: false });
    const result = await verifier.verifyToken({
      tokenDerBase64: 'any_token',
      expectedDigest: new Uint8Array(32),
      digestAlgorithm: 'sha256',
      trustAnchors: [],
    });
    expect(result.status).toBe('invalid');
  });

  it('can disable mismatch check', async () => {
    const verifier = new MockTimestampVerifier({ failOnMismatch: false, defaultStatus: 'valid' });
    const result = await verifier.verifyToken({
      tokenDerBase64: 'any_token',
      expectedDigest: new Uint8Array(32),
      digestAlgorithm: 'sha256',
      trustAnchors: [],
    });
    expect(result.status).toBe('valid');
  });
});
