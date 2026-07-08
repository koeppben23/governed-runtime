/**
 * @module integration/tools/hydrate-policy.test
 * @description Tests for hydrate-policy pure functions.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect, vi } from 'vitest';
import { digestText, mergeCentralEvidence, snapshotCentralEvidence } from './hydrate-policy.js';
import type { PolicyMode } from '../../state/policy-mode.js';
import type { ExistingHydrateState } from './hydrate.js';

vi.mock('../../config/policy.js', () => ({
  validateExistingPolicyAgainstCentral: vi.fn().mockResolvedValue({ valid: true }),
  resolvePolicyForHydrate: vi.fn(),
  detectCiContext: vi.fn(),
}));

// ─── Minimal Fixtures ─────────────────────────────────────────────────────────

function existing(overrides = {}): NonNullable<ExistingHydrateState> {
  return {
    policySnapshot: {
      mode: 'team' as PolicyMode,
      requestedMode: 'team' as PolicyMode,
      source: 'default' as const,
      effectiveGateBehavior: 'human_gated' as const,
      hash: 'snapshot-hash',
      resolvedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  } as NonNullable<ExistingHydrateState>;
}

// ─── digestText ───────────────────────────────────────────────────────────────

describe('digestText', () => {
  it('produces a 64-char hex string', () => {
    const result = digestText('hello');
    expect(result).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result)).toBe(true);
  });

  it('is deterministic', () => {
    expect(digestText('hello')).toBe(digestText('hello'));
  });

  it('differs for different input', () => {
    expect(digestText('hello')).not.toBe(digestText('world'));
  });
});

// ─── mergeCentralEvidence ─────────────────────────────────────────────────────

describe('mergeCentralEvidence', () => {
  it('overrides central evidence fields from central evidence', () => {
    const s = existing();
    const merged = mergeCentralEvidence(s, {
      minimumMode: 'regulated',
      digest: 'c-digest',
      version: 'c-version',
      pathHint: '~/.flowguard/policy.json',
    });
    expect(merged.policySnapshot.centralMinimumMode).toBe('regulated');
    expect(merged.policySnapshot.policyDigest).toBe('c-digest');
    expect(merged.policySnapshot.policyVersion).toBe('c-version');
  });

  it('returns existing unchanged when central evidence is undefined', () => {
    const s = existing();
    const merged = mergeCentralEvidence(s, undefined);
    expect(merged.policySnapshot.mode).toBe('team');
    expect(merged.policySnapshot.centralMinimumMode).toBeUndefined();
  });
});

// ─── snapshotCentralEvidence ──────────────────────────────────────────────────

describe('snapshotCentralEvidence', () => {
  it('extracts central evidence fields from existing state', () => {
    const s = existing({
      policySnapshot: {
        ...existing().policySnapshot,
        centralMinimumMode: 'regulated' as PolicyMode,
        policyDigest: 'digest-1',
        policyVersion: '1.0.0',
      },
    });
    const snap = snapshotCentralEvidence(s);
    expect(snap?.minimumMode).toBe('regulated');
    expect(snap?.digest).toBe('digest-1');
    expect(snap?.version).toBe('1.0.0');
  });

  it('returns undefined when no central minimum mode present', () => {
    const s = existing();
    const snap = snapshotCentralEvidence(s);
    expect(snap).toBeUndefined();
  });
});
