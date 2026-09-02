/**
 * @module adapters/workspace/archive-verify-helpers.test
 * @description Tests for archive verification pure helpers — artifact binding,
 *              audit chain predicates, and policy mode resolution.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, it, expect } from 'vitest';
import {
  findBindingArtifacts,
  findPublicationBinding,
  isArtifactBindingEntry,
  hasTimestampEvidence,
  isCurrentChainIntegrityFailure,
  isAuditFormatFailure,
  auditReadFailureFindingCode,
  resolveArchiveStrictness,
  resolveStrictMode,
  STRICT_WHEN_MODE_UNRESOLVED,
} from './archive-verify-helpers.js';
import type { SessionState } from '../../state/schema.js';
import type { ArchivePublicationBinding } from './archive-artifact-binding.js';

// ─── Minimal Fixtures ─────────────────────────────────────────────────────────

function bindingEvent(artifacts: unknown[]): Record<string, unknown> {
  return {
    event: 'archive:artifacts_bound',
    detail: { schemaVersion: 'flowguard-archive-artifact-binding.v1', artifacts },
  };
}

function auditEvent(
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { event: type, ...overrides };
}

function bindingEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'artifacts/result.json',
    sha256: 'a'.repeat(64),
    artifactType: 'evidence',
    ...overrides,
  };
}

function publicationBinding(): ArchivePublicationBinding {
  return {
    publicationId: 'a'.repeat(64),
    archiveFile: 'session.tar.gz',
    archiveDigest: 'b'.repeat(64),
    sidecarDigest: 'c'.repeat(64),
    manifestContentDigest: 'd'.repeat(64),
  };
}

function sessionState(mode?: string): SessionState | null {
  if (mode === undefined) return null;
  return {
    policySnapshot: { mode },
  } as unknown as SessionState;
}

// ─── findBindingArtifacts ─────────────────────────────────────────────────────

describe('findBindingArtifacts', () => {
  it('returns artifacts from the last ARTIFACT_BINDING_EVENT', () => {
    const events = [bindingEvent([{ path: 'artifacts/a.json' }])];
    expect(findBindingArtifacts(events)).toEqual([{ path: 'artifacts/a.json' }]);
  });

  it('returns undefined when no binding event exists', () => {
    expect(findBindingArtifacts([])).toBeUndefined();
    expect(findBindingArtifacts([auditEvent('other')])).toBeUndefined();
  });

  it('returns undefined for wrong schema version', () => {
    const event = {
      event: 'archive:artifacts_bound',
      detail: { schemaVersion: 'v0', artifacts: [{ path: 'x' }] },
    };
    expect(findBindingArtifacts([event])).toBeUndefined();
  });

  it('returns undefined when artifacts is not an array', () => {
    const event = {
      event: 'archive:artifacts_bound',
      detail: { schemaVersion: 'flowguard-archive-artifact-binding.v1', artifacts: 'not-an-array' },
    };
    expect(findBindingArtifacts([event])).toBeUndefined();
  });

  it('returns undefined when detail is missing', () => {
    const event = { event: 'archive:artifacts_bound' };
    expect(findBindingArtifacts([event])).toBeUndefined();
  });

  it('finds the last binding event when there are interleaved events', () => {
    const events = [
      bindingEvent([{ path: 'artifacts/first.json' }]),
      auditEvent('mid'),
      bindingEvent([{ path: 'artifacts/last.json' }]),
    ];
    expect(findBindingArtifacts(events)).toEqual([{ path: 'artifacts/last.json' }]);
  });
});

describe('findPublicationBinding', () => {
  it('accepts only an exact digest tuple from the publication event contract', () => {
    const expected = publicationBinding();
    const event = {
      event: 'archive:publication_bound',
      detail: { schemaVersion: 'flowguard-archive-publication-binding.v1', ...expected },
    };
    expect(findPublicationBinding([event], expected)).toBe(true);
    expect(findPublicationBinding([event], { ...expected, archiveDigest: 'e'.repeat(64) })).toBe(
      false,
    );
  });

  it('rejects a publication event with an unknown schema version', () => {
    const expected = publicationBinding();
    expect(
      findPublicationBinding(
        [{ event: 'archive:publication_bound', detail: { schemaVersion: 'v0', ...expected } }],
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a historical tuple when a newer binding names the same archive', () => {
    const historical = publicationBinding();
    const current = { ...historical, publicationId: 'e'.repeat(64), archiveDigest: 'f'.repeat(64) };
    const event = (detail: ArchivePublicationBinding) => ({
      event: 'archive:publication_bound',
      detail: { schemaVersion: 'flowguard-archive-publication-binding.v1', ...detail },
    });
    expect(findPublicationBinding([event(historical), event(current)], historical)).toBe(false);
    expect(findPublicationBinding([event(historical), event(current)], current)).toBe(true);
  });
});

// ─── isArtifactBindingEntry ───────────────────────────────────────────────────

describe('isArtifactBindingEntry', () => {
  it('returns true for a valid entry', () => {
    expect(isArtifactBindingEntry(bindingEntry())).toBe(true);
  });

  it('accepts null artifactType', () => {
    expect(isArtifactBindingEntry(bindingEntry({ artifactType: null }))).toBe(true);
  });

  it('returns false for non-objects', () => {
    expect(isArtifactBindingEntry(null)).toBe(false);
    expect(isArtifactBindingEntry(42)).toBe(false);
    expect(isArtifactBindingEntry('string')).toBe(false);
  });

  it('returns false when path does not start with artifacts/', () => {
    expect(isArtifactBindingEntry(bindingEntry({ path: 'other/file.txt' }))).toBe(false);
    expect(isArtifactBindingEntry(bindingEntry({ path: undefined }))).toBe(false);
  });

  it('returns false for invalid sha256', () => {
    expect(isArtifactBindingEntry(bindingEntry({ sha256: 'abc' }))).toBe(false);
    expect(isArtifactBindingEntry(bindingEntry({ sha256: 'g'.repeat(64) }))).toBe(false);
  });
});

// ─── hasTimestampEvidence ─────────────────────────────────────────────────────

describe('hasTimestampEvidence', () => {
  it('returns true when timestampEvidence is a non-null object', () => {
    expect(hasTimestampEvidence({ timestampEvidence: {} })).toBe(true);
    expect(hasTimestampEvidence({ timestampEvidence: { token: 'abc' } })).toBe(true);
  });

  it('returns false when timestampEvidence is missing', () => {
    expect(hasTimestampEvidence({})).toBe(false);
  });

  it('returns false when timestampEvidence is null', () => {
    expect(hasTimestampEvidence({ timestampEvidence: null })).toBe(false);
  });

  it('returns false when timestampEvidence is not an object', () => {
    expect(hasTimestampEvidence({ timestampEvidence: 'string' })).toBe(false);
    expect(hasTimestampEvidence({ timestampEvidence: 42 })).toBe(false);
  });
});

// ─── isCurrentChainIntegrityFailure ───────────────────────────────────────────

describe('isCurrentChainIntegrityFailure', () => {
  it('returns true for current audit-chain integrity failures', () => {
    expect(isCurrentChainIntegrityFailure('CHAIN_BREAK')).toBe(true);
    expect(isCurrentChainIntegrityFailure('CLOCK_ANOMALY')).toBe(true);
  });

  it('returns false for legacy/format reasons (they have their own finding class)', () => {
    expect(isCurrentChainIntegrityFailure('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED')).toBe(false);
  });

  it('returns false for other reasons', () => {
    expect(isCurrentChainIntegrityFailure('TIMESTAMP_EVIDENCE_MISSING')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCurrentChainIntegrityFailure(null)).toBe(false);
  });
});

// ─── isAuditFormatFailure ─────────────────────────────────────────────────────

describe('isAuditFormatFailure', () => {
  it('returns true for LEGACY_ASSURANCE_FORMAT_UNSUPPORTED', () => {
    expect(isAuditFormatFailure('LEGACY_ASSURANCE_FORMAT_UNSUPPORTED')).toBe(true);
  });

  it('returns true for AUDIT_ENVELOPE_INVALID', () => {
    expect(isAuditFormatFailure('AUDIT_ENVELOPE_INVALID')).toBe(true);
  });

  it('returns false for other reasons', () => {
    expect(isAuditFormatFailure('CHAIN_BREAK')).toBe(false);
    expect(isAuditFormatFailure('CLOCK_ANOMALY')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAuditFormatFailure(null)).toBe(false);
  });
});

// ─── auditReadFailureFindingCode ──────────────────────────────────────────────

describe('auditReadFailureFindingCode', () => {
  it('maps the legacy read failure to audit_chain_legacy_format', () => {
    expect(auditReadFailureFindingCode({ code: 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED' })).toBe(
      'audit_chain_legacy_format',
    );
  });

  it('maps the envelope-invalid read failure to audit_chain_invalid_event', () => {
    expect(auditReadFailureFindingCode({ code: 'AUDIT_ENVELOPE_INVALID' })).toBe(
      'audit_chain_invalid_event',
    );
  });

  it('falls back to audit_chain_invalid for any other failure', () => {
    expect(auditReadFailureFindingCode({ code: 'READ_FAILED' })).toBe('audit_chain_invalid');
    expect(auditReadFailureFindingCode(new Error('boom'))).toBe('audit_chain_invalid');
    expect(auditReadFailureFindingCode(null)).toBe('audit_chain_invalid');
  });
});

// ─── resolveStrictMode ────────────────────────────────────────────────────────

describe('resolveStrictMode', () => {
  it('returns true for regulated mode', () => {
    expect(resolveStrictMode(sessionState('regulated'))).toBe(true);
  });

  it('returns false for team mode', () => {
    expect(resolveStrictMode(sessionState('team'))).toBe(false);
  });

  it('returns false for solo mode', () => {
    expect(resolveStrictMode(sessionState('solo'))).toBe(false);
  });

  it('returns false for team-ci mode', () => {
    expect(resolveStrictMode(sessionState('team-ci'))).toBe(false);
  });

  it('returns STRICT_WHEN_MODE_UNRESOLVED for null state', () => {
    expect(resolveStrictMode(null)).toBe(STRICT_WHEN_MODE_UNRESOLVED);
    expect(STRICT_WHEN_MODE_UNRESOLVED).toBe(true);
  });

  it('returns STRICT_WHEN_MODE_UNRESOLVED for invalid mode', () => {
    expect(resolveStrictMode(sessionState('unknown'))).toBe(true);
  });
});

describe('resolveArchiveStrictness', () => {
  it('records whether strictness was resolved from trusted policy state', () => {
    expect(resolveArchiveStrictness(sessionState('regulated'))).toEqual({
      strict: true,
      policyStateResolved: true,
    });
    expect(resolveArchiveStrictness(sessionState('team'))).toEqual({
      strict: false,
      policyStateResolved: true,
    });
  });

  it('fails closed and reports unresolved strictness for missing or invalid state', () => {
    expect(resolveArchiveStrictness(null)).toEqual({ strict: true, policyStateResolved: false });
    expect(resolveArchiveStrictness(sessionState('unknown'))).toEqual({
      strict: true,
      policyStateResolved: false,
    });
  });
});
