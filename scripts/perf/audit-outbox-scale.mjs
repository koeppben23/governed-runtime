/**
 * Bounded audit-outbox checkpoint at scale.
 *
 * npm run build
 * AUDIT_OUTBOX_DEPTH=100000 node scripts/perf/audit-outbox-scale.mjs
 *
 * Builds one canonical chain, then verifies that compacting a reconciled
 * outbox at that depth retires only the verified oldest operations and writes
 * a checkpoint anchored to the exact canonical event. The state is persisted
 * and re-read through the production state boundary.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuditTrail } from '../../dist/adapters/persistence-audit.js';
import { readState, writeState } from '../../dist/adapters/persistence.js';
import { verifyChain } from '../../dist/audit/integrity.js';
import { compactVerifiedOutbox } from '../../dist/audit/outbox-compaction.js';
import { computeCanonicalEventDigest } from '../../dist/audit/canonical-digest.js';
import {
  CURRENT_AUDIT_FORMAT_VERSION,
  GENESIS_HASH,
  computeChainHash,
} from '../../dist/audit/types.js';

const depth = Number(process.env.AUDIT_OUTBOX_DEPTH ?? '100000');
const sessionId = '00000000-0000-4000-8000-000000000001';
const fixturePath = fileURLToPath(
  new URL('./fixtures/minimal-session-state.json', import.meta.url),
);

function seededLine(index, prevHash) {
  const id = randomUUID();
  const body = {
    id,
    flowguardSessionId: sessionId,
    hostSessionId: 'ses_outbox',
    phase: 'IMPLEMENTATION',
    event: 'state_write',
    occurredAt: '2026-11-15T12:00:00.000Z',
    actor: 'machine',
    detail: { operationId: id, index, pad: 'x'.repeat(100) },
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    auditSequence: index + 1,
    recordedAt: '2026-11-15T12:00:00.000Z',
    prevHash,
  };
  const semanticEventDigest = computeCanonicalEventDigest(body);
  const finalized = { ...body, semanticEventDigest };
  const chainHash = computeChainHash(prevHash, finalized);
  return { line: `${JSON.stringify({ ...finalized, chainHash })}\n`, chainHash };
}

function operationFor(event) {
  return {
    kind: 'state_write',
    operationId: event.id,
    preStateDigest: 'a'.repeat(64),
    mutationDigest: 'b'.repeat(64),
    postStateDigest: 'c'.repeat(64),
    auditEventDigest: computeCanonicalEventDigest(event),
    status: 'reconciled',
    stateWrite: { phase: event.phase, at: event.occurredAt },
  };
}

const dir = await mkdtemp(join(tmpdir(), 'fg-audit-outbox-'));
try {
  const filePath = join(dir, 'audit.jsonl');
  const lines = [];
  let prevHash = GENESIS_HASH;
  const seedStarted = Date.now();
  for (let index = 0; index < depth; index++) {
    const seeded = seededLine(index, prevHash);
    prevHash = seeded.chainHash;
    lines.push(seeded.line);
  }
  await writeFile(filePath, lines.join(''), 'utf8');
  const seedMs = Date.now() - seedStarted;

  const trail = await readAuditTrail(dir);
  const verified = verifyChain(trail);
  if (!verified.valid || trail.length !== depth) {
    throw new Error(`seeded chain invalid: ${verified.reason ?? `count ${trail.length}`}`);
  }

  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  await writeState(dir, fixture);
  const pending = trail.slice(-65).map(operationFor);
  const before = { ...fixture, pendingAuditOperations: pending };
  const compacted = compactVerifiedOutbox(before, trail);
  await writeState(dir, compacted);
  const after = await readState(dir);
  if (!after) throw new Error('compacted state disappeared');

  const checkpoint = after.auditOutboxCheckpoint;
  const anchored = checkpoint ? trail[checkpoint.auditSequence - 1] : undefined;
  const valid =
    after.pendingAuditOperations.length === 32 &&
    after.pendingAuditOperations.every((operation) => operation.status === 'reconciled') &&
    checkpoint !== undefined &&
    checkpoint.reconciledCount === 33 &&
    anchored !== undefined &&
    anchored.id === checkpoint.lastOperationId &&
    anchored.chainHash === checkpoint.chainHash &&
    computeCanonicalEventDigest(anchored) === checkpoint.auditEventDigest;
  const result = {
    benchmark: 'audit-outbox-scale',
    depth,
    seedMs,
    pendingBefore: pending.length,
    pendingAfter: after.pendingAuditOperations.length,
    reconciledAfter: after.pendingAuditOperations.filter(
      (operation) => operation.status === 'reconciled',
    ).length,
    checkpoint: checkpoint ?? null,
    anchoredSequence: anchored?.auditSequence ?? null,
    result: valid ? 'PASS' : 'FAIL',
  };
  console.log(JSON.stringify(result));
  if (!valid) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
