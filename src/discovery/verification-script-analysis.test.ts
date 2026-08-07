/**
 * @module discovery/verification-script-analysis.test
 * @description Tests for provider-aware script analysis.
 */

import { describe, expect, it } from 'vitest';
import { analyzeVerificationScript } from './verification-script-analysis.js';
import { DESCRIPTOR_BY_PROVIDER, type ScriptSignature } from './assertion-provider-catalog.js';
import type { ProviderId } from '../state/assertion-identity.js';

function buildSigMap(): ReadonlyMap<ProviderId, readonly ScriptSignature[]> {
  const map = new Map<ProviderId, ScriptSignature[]>();
  for (const descriptor of DESCRIPTOR_BY_PROVIDER.values()) {
    if (descriptor.scriptSignatures?.length) {
      map.set(descriptor.providerId, [...descriptor.scriptSignatures]);
    }
  }
  return map;
}

const SIGNATURES = buildSigMap();

describe('analyzeVerificationScript', () => {
  it('vitest run → identified / high / enrichable', () => {
    const result = analyzeVerificationScript('test', 'vitest run', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('vitest');
      expect(result.provider.confidence).toBe('high');
    }
    expect(result.isCompound).toBe(false);
    expect(result.reporterConflict).toBe(false);
    expect(result.argumentForwarding).toBe('supported');
  });

  it('bare jest → identified / high', () => {
    const result = analyzeVerificationScript('test', 'jest', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('jest');
      expect(result.provider.confidence).toBe('high');
    }
  });

  it('jest --runInBand → identified', () => {
    const result = analyzeVerificationScript('test', 'jest --runInBand', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('jest');
    }
  });

  it('python -m pytest → identified / high via module invocation', () => {
    const result = analyzeVerificationScript('test', 'python -m pytest', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('pytest');
    }
  });

  it('bare pytest → identified', () => {
    const result = analyzeVerificationScript('test', 'pytest', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('pytest');
    }
  });

  it('go test ./... → identified', () => {
    const result = analyzeVerificationScript('test', 'go test ./...', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('go_test');
    }
  });

  it('go test -race ./... → identified', () => {
    const result = analyzeVerificationScript('test', 'go test -race ./...', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('go_test');
    }
  });

  it('npx vitest → identified / medium', () => {
    const result = analyzeVerificationScript('test', 'npx vitest', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('vitest');
      expect(result.provider.confidence).toBe('medium');
    }
  });

  it('pnpm exec vitest → identified / medium', () => {
    const result = analyzeVerificationScript('test', 'pnpm exec vitest', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('vitest');
    }
  });

  it('cross-env FOO=bar vitest run → identified after prefix strip', () => {
    const result = analyzeVerificationScript(
      'test',
      'cross-env NODE_ENV=test vitest run',
      SIGNATURES,
    );
    expect(result.provider.status).toBe('identified');
    if (result.provider.status === 'identified') {
      expect(result.provider.providerId).toBe('vitest');
    }
  });

  it('node scripts/test.js → unidentified', () => {
    const result = analyzeVerificationScript('test', 'node scripts/test.js', SIGNATURES);
    expect(result.provider.status).toBe('unidentified');
  });

  it('bash ci/test.sh → unidentified', () => {
    const result = analyzeVerificationScript('test', 'bash ci/test.sh', SIGNATURES);
    expect(result.provider.status).toBe('unidentified');
  });

  it('vitest && cleanup → identified but compound', () => {
    const result = analyzeVerificationScript('test', 'vitest && cleanup', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    expect(result.isCompound).toBe(true);
    expect(result.argumentForwarding).toBe('unsupported');
  });

  it('vitest --reporter=junit → identified but reporter conflict', () => {
    const result = analyzeVerificationScript('test', 'vitest --reporter=junit', SIGNATURES);
    expect(result.provider.status).toBe('identified');
    expect(result.reporterConflict).toBe(true);
  });

  it('turbo test → unidentified', () => {
    const result = analyzeVerificationScript('test', 'turbo test', SIGNATURES);
    expect(result.provider.status).toBe('unidentified');
  });

  it('make test → unidentified', () => {
    const result = analyzeVerificationScript('test', 'make test', SIGNATURES);
    expect(result.provider.status).toBe('unidentified');
  });

  it('docker compose run tests → unidentified', () => {
    const result = analyzeVerificationScript('test', 'docker compose run tests', SIGNATURES);
    expect(result.provider.status).toBe('unidentified');
  });
});
