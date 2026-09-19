/**
 * @module adapters/workspace/archive-verify-audit-chain-mutation.test
 * @description Mutation-focused contract tests for the audit-chain verification
 * stage: completeness anchor (count/head), policy-mode cross-check, timestamp
 * strictness derivation, governed session binding, envelope-invalid projection,
 * regulated completeness, and fail-closed audit read errors.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendAuditEvent } from '../persistence-audit.js';
import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import type { AuditEvent } from '../../state/evidence.js';
import type { TimestampEvidence } from '../../state/evidence-timestamp.js';
import type { SessionState } from '../../state/schema.js';
import {
  FIXED_FINGERPRINT,
  makeState,
  POLICY_SNAPSHOT,
  REGULATED_POLICY_SNAPSHOT,
  REVIEW_APPROVE,
} from '../../fixtures.js';
import {
  runWithAdapterLogger,
  runWithAdapterLoggerAsync,
  type AdapterLogger,
} from '../../logging/adapter-logger.js';
import { verifyArchiveTimestampTokens } from './archive-timestamp-verification.js';
import {
  verifyAuditChainIntegrity,
  verifyManifestPolicyMode,
} from './archive-verify-audit-chain.js';

/**
 * Per-test override of the audit-trail read boundary. `undefined` keeps the
 * real filesystem reader; an array injects a raw trail that the persistence
 * boundary would otherwise reject before chain verification sees it.
 */
const readTrailOverride: { current: AuditEvent[] | undefined } = { current: undefined };

vi.mock('../persistence-audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persistence-audit.js')>();
  return {
    ...actual,
    readAuditTrail: (sessionDir: string) =>
      Promise.resolve(readTrailOverride.current ?? actual.readAuditTrail(sessionDir)),
  };
});

vi.mock('./archive-timestamp-verification.js', () => ({
  verifyArchiveTimestampTokens: vi.fn(async () => {}),
}));

const AT = '2026-01-01T00:00:00.000Z';
const SESSION_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION_UUID = '22222222-2222-4222-8222-222222222222';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

beforeEach(() => {
  readTrailOverride.current = undefined;
  vi.mocked(verifyArchiveTimestampTokens).mockClear();
});

async function createAuditRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-chain-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'audit'), { recursive: true });
  return root;
}

async function appendEvent(
  root: string,
  input: {
    readonly event: string;
    readonly detail: Record<string, unknown>;
    readonly flowguardSessionId?: string;
    readonly timestampEvidence?: TimestampEvidence;
  },
): Promise<AuditEvent> {
  return appendAuditEvent(path.join(root, 'audit'), {
    id: randomUUID(),
    flowguardSessionId: input.flowguardSessionId ?? SESSION_UUID,
    phase: 'COMPLETE',
    event: input.event,
    occurredAt: AT,
    actor: 'machine',
    detail: input.detail,
    ...(input.timestampEvidence === undefined
      ? {}
      : { timestampEvidence: input.timestampEvidence }),
  });
}

function manifest(overrides: Partial<ArchiveManifest> = {}): ArchiveManifest {
  return {
    schemaVersion: 'archive-manifest.v3',
    layoutVersion: 2,
    createdAt: AT,
    sessionId: SESSION_UUID,
    fingerprint: FIXED_FINGERPRINT,
    policyMode: 'team',
    profileId: 'default',
    discoveryDigest: null,
    auditChainHead: 'genesis',
    auditEventCount: 0,
    includedFiles: [],
    fileDigests: {},
    contentDigest: 'a'.repeat(64),
    ...overrides,
  };
}

interface LogCall {
  readonly service: string;
  readonly message: string;
  readonly extra: Record<string, unknown> | undefined;
}

function recordingLogger(calls: LogCall[]): AdapterLogger {
  return {
    info: () => {},
    warn: () => {},
    error: (service, message, extra) => {
      calls.push({ service, message, extra });
    },
  };
}

describe('verifyManifestPolicyMode', () => {
  it('skips a state whose policy snapshot is unresolvable at runtime', () => {
    const state = { policySnapshot: null } as unknown as SessionState;
    const findings: ArchiveFinding[] = [];

    expect(() => verifyManifestPolicyMode(manifest(), state, findings)).not.toThrow();
    expect(findings).toEqual([]);
  });

  it('skips a state whose mode is not a governed policy mode', () => {
    const state = { policySnapshot: { mode: 'bogus' } } as unknown as SessionState;
    const findings: ArchiveFinding[] = [];

    verifyManifestPolicyMode(manifest(), state, findings);

    expect(findings).toEqual([]);
  });

  it('accepts an exact manifest/state mode match', () => {
    const findings: ArchiveFinding[] = [];

    verifyManifestPolicyMode(manifest(), makeState('READY'), findings);

    expect(findings).toEqual([]);
  });

  it('fails closed and logs both modes when the manifest mode disagrees with the state mode', () => {
    const manifestPolicyMode = manifest({ policyMode: 'regulated' });
    const findings: ArchiveFinding[] = [];
    const calls: LogCall[] = [];

    runWithAdapterLogger(recordingLogger(calls), () =>
      verifyManifestPolicyMode(manifestPolicyMode, makeState('READY'), findings),
    );

    expect(findings).toEqual([
      {
        code: 'manifest_policy_mode_mismatch',
        severity: 'error',
        message: "Manifest policyMode 'regulated' does not match governed state mode 'team'",
        file: 'archive-manifest.json',
      },
    ]);
    expect(calls).toEqual([
      {
        service: 'archive',
        message: 'Manifest policy mode does not match governed state',
        extra: {
          reason: 'manifest_policy_mode_mismatch',
          manifestMode: 'regulated',
          stateMode: 'team',
        },
      },
    ]);
  });
});

describe('verifyAuditChainIntegrity completeness anchor', () => {
  it('fails closed on a stale manifest count even when the chain head still matches', async () => {
    const root = await createAuditRoot();
    const event = await appendEvent(root, {
      event: 'lifecycle:session_completed',
      detail: { kind: 'lifecycle', action: 'session_completed' },
    });
    const findings: ArchiveFinding[] = [];
    const calls: LogCall[] = [];

    await runWithAdapterLoggerAsync(recordingLogger(calls), () =>
      verifyAuditChainIntegrity(
        root,
        manifest({ auditChainHead: event.chainHash, auditEventCount: 2 }),
        findings,
        null,
        false,
      ),
    );

    expect(findings).toEqual([
      {
        code: 'audit_chain_truncated',
        severity: 'error',
        message: 'Audit trail does not match manifest anchor: expected 2 event(s), found 1',
        file: 'audit.jsonl',
      },
    ]);
    expect(calls).toEqual([
      {
        service: 'archive',
        message: 'Audit trail completeness anchor mismatch',
        extra: {
          reason: 'audit_chain_truncated',
          expectedCount: 2,
          actualCount: 1,
          expectedHead: event.chainHash.slice(0, 16),
          actualHead: event.chainHash.slice(0, 16),
        },
      },
    ]);
  });
});

describe('verifyAuditChainIntegrity timestamp strictness', () => {
  it('derives strictness from per-event evidence and reports missing critical evidence as warnings', async () => {
    const root = await createAuditRoot();
    await appendEvent(root, {
      event: 'lifecycle:session_completed',
      detail: { kind: 'lifecycle', action: 'session_completed' },
    });
    const evidenceEvent = await appendEvent(root, {
      event: 'custom:non-critical',
      detail: { kind: 'custom' },
      timestampEvidence: { status: 'ntp_checked', source: 'ntp', resolvedAt: AT },
    });
    const findings: ArchiveFinding[] = [];

    await runWithAdapterLoggerAsync(recordingLogger([]), () =>
      verifyAuditChainIntegrity(
        root,
        manifest({ auditChainHead: evidenceEvent.chainHash, auditEventCount: 2 }),
        findings,
        null,
        false,
      ),
    );

    expect(findings).toEqual([
      {
        code: 'timestamp_unanchored',
        severity: 'warning',
        message: 'Timestamp verification failed (TIMESTAMP_EVIDENCE_MISSING): 2 total, 2 verified',
        file: 'audit.jsonl',
      },
      {
        code: 'timestamp_unanchored',
        severity: 'warning',
        message: '1 critical event(s) lack timestamp assurance evidence (indices: 0)',
        file: 'audit.jsonl',
      },
    ]);
  });

  it('escalates when the policy enables timestamp assurance without per-event evidence', async () => {
    const root = await createAuditRoot();
    const event = await appendEvent(root, {
      event: 'lifecycle:session_completed',
      detail: { kind: 'lifecycle', action: 'session_completed' },
    });
    const state = makeState('READY', {
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        audit: {
          ...POLICY_SNAPSHOT.audit,
          timestampAssurance: {
            ...POLICY_SNAPSHOT.audit.timestampAssurance,
            enabled: true,
          },
        },
      },
    });
    const findings: ArchiveFinding[] = [];

    await runWithAdapterLoggerAsync(recordingLogger([]), () =>
      verifyAuditChainIntegrity(
        root,
        manifest({ auditChainHead: event.chainHash, auditEventCount: 1 }),
        findings,
        state,
        false,
      ),
    );

    expect(findings).toContainEqual({
      code: 'timestamp_unanchored',
      severity: 'warning',
      message: '1 critical event(s) lack timestamp assurance evidence (indices: 0)',
      file: 'audit.jsonl',
    });
  });

  it('binds chain verification to the governed session id and logs the break', async () => {
    const root = await createAuditRoot();
    const event = await appendEvent(root, {
      event: 'custom:non-critical',
      detail: { kind: 'custom' },
    });
    const state = makeState('READY', { flowguardSessionId: OTHER_SESSION_UUID });
    const findings: ArchiveFinding[] = [];
    const calls: LogCall[] = [];

    await runWithAdapterLoggerAsync(recordingLogger(calls), () =>
      verifyAuditChainIntegrity(
        root,
        manifest({ auditChainHead: event.chainHash, auditEventCount: 1 }),
        findings,
        state,
        false,
      ),
    );

    expect(findings).toEqual([
      {
        code: 'audit_chain_invalid',
        severity: 'error',
        message: 'Audit chain verification failed (CHAIN_BREAK): 1 total, 1 verified',
        file: 'audit.jsonl',
      },
    ]);
    expect(calls).toContainEqual({
      service: 'archive',
      message: 'Audit chain verification failed',
      extra: { eventId: event.id, reason: 'CHAIN_BREAK' },
    });
  });

  it('skips timestamp-chain verification entirely for an empty audit trail', async () => {
    const root = await createAuditRoot();
    const findings: ArchiveFinding[] = [];

    await verifyAuditChainIntegrity(root, manifest(), findings, null, false);

    expect(findings).toEqual([]);
    expect(verifyArchiveTimestampTokens).not.toHaveBeenCalled();
  });
});

describe('verifyAuditChainIntegrity chain-result projection', () => {
  it('projects an envelope-invalid chain result to audit_chain_invalid_event', async () => {
    const root = await createAuditRoot();
    readTrailOverride.current = [{ event: 'legacy-record' } as unknown as AuditEvent];
    const findings: ArchiveFinding[] = [];

    await runWithAdapterLoggerAsync(recordingLogger([]), () =>
      verifyAuditChainIntegrity(
        root,
        manifest({ auditEventCount: 1, auditChainHead: 'genesis' }),
        findings,
        null,
        false,
      ),
    );

    expect(findings).toEqual([
      {
        code: 'audit_chain_invalid_event',
        severity: 'error',
        message:
          'Audit chain contains records that violate the canonical audit-chain.v3 event ' +
          'envelope. Non-v3 assurance artifacts cannot be treated as verifiable evidence.',
        file: 'audit.jsonl',
      },
    ]);
  });

  it('runs regulated completion completeness against the read audit trail', async () => {
    const root = await createAuditRoot();
    const event = await appendEvent(root, {
      event: 'custom:non-critical',
      detail: { kind: 'custom' },
    });
    const state = makeState('COMPLETE', {
      policySnapshot: REGULATED_POLICY_SNAPSHOT,
      reviewDecision: REVIEW_APPROVE,
      regulatedArchiveStatus: 'verified',
      transition: { from: 'IMPL_REVIEW', to: 'COMPLETE', event: 'APPROVE', at: AT },
    });
    const findings: ArchiveFinding[] = [];

    await runWithAdapterLoggerAsync(recordingLogger([]), () =>
      verifyAuditChainIntegrity(
        root,
        manifest({ auditChainHead: event.chainHash, auditEventCount: 1 }),
        findings,
        state,
        false,
      ),
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        code: 'regulated_terminal_transition_missing',
        severity: 'error',
      }),
    );
  });

  it('fails closed when the audit trail cannot be read as canonical JSONL', async () => {
    const root = await createAuditRoot();
    await fs.writeFile(path.join(root, 'audit', 'audit.jsonl'), '{not jsonl\n', 'utf8');
    const findings: ArchiveFinding[] = [];

    await verifyAuditChainIntegrity(root, manifest(), findings, null, false);

    expect(findings).toEqual([
      {
        code: 'audit_chain_invalid_event',
        severity: 'error',
        message: expect.stringMatching(/^Audit chain verification could not read audit\.jsonl: /),
        file: 'audit.jsonl',
      },
    ]);
  });
});
