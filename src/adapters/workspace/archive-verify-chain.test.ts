import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeferredTimestampReason, timestampFindingCode } from './archive-verify-helpers.js';
import { snapshotArchive } from './archive-files.js';
import { addTimestampFindings } from './archive-verify-chain.js';
import type { ChainVerification } from '../../audit/integrity.js';
import type { ArchiveFinding } from '../../archive/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('timestampFindingCode', () => {
  it('maps a TSA imprint mismatch to tsa_verification_failed', () => {
    expect(timestampFindingCode('TSA_MESSAGE_IMPRINT_MISMATCH')).toBe('tsa_verification_failed');
  });

  it('treats pending token verification as deferred, not failed', () => {
    // The synchronous verifier refuses to trust the mutable cached
    // messageImprint and defers to the asynchronous RFC3161 verifier. Mapping
    // that to a terminal finding made a valid, correctly signed token fail the
    // archive verification, because findings are append-only.
    expect(isDeferredTimestampReason('TOKEN_VERIFICATION_REQUIRED')).toBe(true);
    // Defense in depth: even if a future caller reached the code mapper with a
    // deferred reason, it must never resolve to a terminal TSA failure.
    expect(timestampFindingCode('TOKEN_VERIFICATION_REQUIRED')).not.toBe('tsa_verification_failed');
  });

  it('treats every terminal reason as non-deferred', () => {
    for (const reason of [
      'TSA_MESSAGE_IMPRINT_MISMATCH',
      'TSA_EVIDENCE_DOWNGRADED',
      'CLOCK_ANOMALY',
      'TIMESTAMP_EVIDENCE_MISSING',
      'CHAIN_BREAK',
      'AUDIT_ENVELOPE_INVALID',
      null,
    ] as const) {
      expect(isDeferredTimestampReason(reason)).toBe(false);
    }
  });

  it('AC2: maps downgraded evidence to its own diagnostic code', () => {
    expect(timestampFindingCode('TSA_EVIDENCE_DOWNGRADED')).toBe('tsa_evidence_downgraded');
  });

  it('maps other timestamp failures to timestamp_unanchored', () => {
    expect(timestampFindingCode('CLOCK_ANOMALY')).toBe('timestamp_unanchored');
    expect(timestampFindingCode('TIMESTAMP_EVIDENCE_MISSING')).toBe('timestamp_unanchored');
  });
});

function chainVerification(overrides: Partial<ChainVerification> = {}): ChainVerification {
  return {
    valid: false,
    totalEvents: 3,
    verifiedCount: 3,
    skippedCount: 0,
    firstBreak: null,
    results: [],
    reason: null,
    timestampMonotonicity: { valid: true, firstBreak: null, message: null },
    missingTimestampEvidence: [],
    tsaImprintMismatches: [],
    tokenVerificationRequired: [],
    tsaEvidenceDowngraded: [],
    ...overrides,
  };
}

describe('addTimestampFindings', () => {
  it('reports a chain break as an integrity error', () => {
    const findings: ArchiveFinding[] = [];

    addTimestampFindings(chainVerification({ reason: 'CHAIN_BREAK' }), false, findings);

    expect(findings).toEqual([
      {
        code: 'audit_chain_invalid',
        severity: 'error',
        message: 'Audit chain verification failed (CHAIN_BREAK): 3 total, 3 verified, 0 skipped',
        file: 'audit.jsonl',
      },
    ]);
  });

  it('preserves every fatal timestamp assurance failure', () => {
    const findings: ArchiveFinding[] = [];

    addTimestampFindings(
      chainVerification({
        reason: 'TSA_EVIDENCE_DOWNGRADED',
        timestampMonotonicity: { valid: false, firstBreak: 2, message: 'clock moved backwards' },
        missingTimestampEvidence: [0],
        tsaImprintMismatches: [1],
      }),
      true,
      findings,
    );

    expect(findings).toEqual([
      {
        code: 'tsa_evidence_downgraded',
        severity: 'error',
        message: 'Timestamp verification failed (TSA_EVIDENCE_DOWNGRADED): 3 total, 3 verified',
        file: 'audit.jsonl',
      },
      {
        code: 'timestamp_unanchored',
        severity: 'error',
        message: 'Timestamp monotonicity violation: clock moved backwards',
        file: 'audit.jsonl',
      },
      {
        code: 'timestamp_unanchored',
        severity: 'error',
        message: '1 critical event(s) lack timestamp assurance evidence (indices: 0)',
        file: 'audit.jsonl',
      },
      {
        code: 'tsa_verification_failed',
        severity: 'error',
        message: '1 event(s) have TSA messageImprint mismatch (indices: 1)',
        file: 'audit.jsonl',
      },
    ]);
  });

  it('keeps deferred token verification out of append-only findings', () => {
    const findings: ArchiveFinding[] = [];

    addTimestampFindings(
      chainVerification({ reason: 'TOKEN_VERIFICATION_REQUIRED' }),
      true,
      findings,
    );

    expect(findings).toEqual([]);
  });

  it('projects non-fatal timestamp failures and evidence gaps as ordered warnings', () => {
    const findings: ArchiveFinding[] = [];

    addTimestampFindings(
      chainVerification({
        reason: 'TIMESTAMP_EVIDENCE_MISSING',
        timestampMonotonicity: { valid: false, firstBreak: 2, message: 'clock moved backwards' },
        missingTimestampEvidence: [0, 2],
        tsaImprintMismatches: [1],
      }),
      false,
      findings,
    );

    expect(findings).toEqual([
      {
        code: 'timestamp_unanchored',
        severity: 'warning',
        message: 'Timestamp verification failed (TIMESTAMP_EVIDENCE_MISSING): 3 total, 3 verified',
        file: 'audit.jsonl',
      },
      {
        code: 'timestamp_unanchored',
        severity: 'warning',
        message: 'Timestamp monotonicity violation: clock moved backwards',
        file: 'audit.jsonl',
      },
      {
        code: 'timestamp_unanchored',
        severity: 'warning',
        message: '2 critical event(s) lack timestamp assurance evidence (indices: 0, 2)',
        file: 'audit.jsonl',
      },
      {
        code: 'tsa_verification_failed',
        severity: 'warning',
        message: '1 event(s) have TSA messageImprint mismatch (indices: 1)',
        file: 'audit.jsonl',
      },
    ]);
  });

  it('does not duplicate the generic timestamp finding for an audit envelope failure', () => {
    const findings: ArchiveFinding[] = [];

    addTimestampFindings(chainVerification({ reason: 'AUDIT_ENVELOPE_INVALID' }), true, findings);

    expect(findings).toEqual([]);
  });
});

describe('snapshotArchive', () => {
  it('preserves inspected archive bytes when the source path is later replaced', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-snapshot-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.tar.gz');
    const snapshot = path.join(root, 'snapshot.tar.gz');
    await fs.writeFile(source, 'verified archive bytes', 'utf8');

    await snapshotArchive(source, snapshot);
    await fs.writeFile(source, 'replaced archive bytes', 'utf8');

    await expect(fs.readFile(snapshot, 'utf8')).resolves.toBe('verified archive bytes');
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('replaced archive bytes');
  });
});
