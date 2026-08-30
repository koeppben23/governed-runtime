/**
 * @module state/evidence-audit.fuzz.test
 * @description Property-based fuzz tests for audit chain tamper detection.
 *
 * Builds valid hash chains, then applies random tamper operations
 * (mutate, delete non-tail, reorder, insert without rechain) and verifies
 * that verifyChain detects each tamper.
 *
 * All event IDs are generated deterministically from the seed/position
 * to guarantee reproducible counterexamples via FAST_CHECK_SEED.
 *
 * Untampered chains always verify successfully.
 *
 * run control:
 *   FAST_CHECK_NUM_RUNS=100 npx vitest run --project fuzz
 *   FAST_CHECK_SEED=12345 npx vitest run --project fuzz
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/347
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { verifyChain } from '../audit/integrity.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { computeChainHash, CURRENT_AUDIT_FORMAT_VERSION, GENESIS_HASH } from '../audit/types.js';
import type { ChainedAuditEvent } from '../audit/types.js';

interface ChainedRecord extends Record<string, unknown> {
  id: string;
  flowguardSessionId: string;
  hostSessionId?: string;
  phase: string;
  event: string;
  auditSequence: number;
  occurredAt: string;
  recordedAt: string;
  semanticEventDigest: string;
  actor: string;
  auditFormatVersion: string;
  detail: Record<string, unknown>;
  prevHash: string;
  chainHash: string;
}

function makeId(chainSeed: number, idx: number): string {
  // Deterministic UUID from seed and position.
  const hex = ((chainSeed * 31 + idx) * 0x811c9dc5).toString(16).padStart(16, '0');
  return `00000000-0000-4000-8000-${hex.slice(-12)}`;
}

function buildEvent(id: string, prevHash: string, idx: number): ChainedRecord {
  const bodyWithoutDigest = {
    id,
    flowguardSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    phase: 'PLAN',
    event: 'transition:PLAN_READY',
    auditSequence: idx + 1,
    occurredAt: `2026-01-01T00:${String(idx).padStart(2, '0')}:00.000Z`,
    recordedAt: `2026-01-01T00:${String(idx).padStart(2, '0')}:00.000Z`,
    actor: 'machine',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: {
      kind: 'transition' as const,
      from: 'TICKET' as const,
      to: 'PLAN' as const,
      event: 'PLAN_READY' as const,
      autoAdvanced: false,
      chainIndex: idx,
    },
    prevHash,
  };
  // The semantic digest authority is recomputed by the verifier — a synthetic
  // placeholder would make every compliant chain invalid.
  const semanticEventDigest = computeCanonicalEventDigest(
    bodyWithoutDigest as unknown as Record<string, unknown>,
  );
  const body = {
    ...bodyWithoutDigest,
    semanticEventDigest,
  } satisfies Omit<ChainedAuditEvent, 'chainHash'>;
  return {
    ...body,
    chainHash: computeChainHash(prevHash, body),
  };
}

function buildChain(length: number): ChainedRecord[] {
  const events: ChainedRecord[] = [];
  let prevHash: string = GENESIS_HASH;
  // Use a fixed chain seed for reproducibility — derived from the length
  // so different chain lengths produce different IDs but same length = same IDs.
  const chainSeed = length;
  for (let i = 0; i < length; i++) {
    const event = buildEvent(makeId(chainSeed, i), prevHash, i);
    events.push(event);
    prevHash = event.chainHash;
  }
  return events;
}

type TamperOp =
  | { kind: 'mutate'; index: number }
  | { kind: 'delete'; index: number }
  | { kind: 'reorder'; index: number }
  | { kind: 'insert_no_rechain'; index: number };

function applyTamper(events: ChainedRecord[], op: TamperOp): ChainedRecord[] {
  const copy = events.map((e) => ({ ...e }));

  switch (op.kind) {
    case 'mutate': {
      const idx = op.index % copy.length;
      copy[idx] = { ...copy[idx]!, phase: 'TAMPERED' };
      break;
    }
    case 'delete': {
      const idx = op.index % copy.length;
      copy.splice(idx, 1);
      break;
    }
    case 'reorder': {
      const idx = op.index % (copy.length - 1);
      const tmp = copy[idx]!;
      copy[idx] = copy[idx + 1]!;
      copy[idx + 1] = tmp;
      break;
    }
    case 'insert_no_rechain': {
      const idx = op.index % (copy.length + 1);
      const prevHash = idx === 0 ? GENESIS_HASH : (copy[idx - 1]?.chainHash ?? GENESIS_HASH);
      copy.splice(idx, 0, buildEvent(makeId(0, 999), prevHash, 999));
      break;
    }
  }

  return copy;
}

describe('audit chain fuzz', () => {
  it('untampered chains always verify successfully', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (length) => {
        const chain = buildChain(length);
        const result = verifyChain(chain as unknown as Record<string, unknown>[], {
          strict: true,
        });
        expect(result.valid).toBe(true);
        expect(result.verifiedCount).toBe(length);
        expect(result.firstBreak).toBeNull();
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('mutate, reorder, and insert tamper always produce CHAIN_BREAK', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 30 }),
        fc
          .integer({ min: 0, max: 2 })
          .map((n) => ['mutate', 'reorder', 'insert_no_rechain'][n]! as TamperOp['kind']),
        fc.integer({ min: 0, max: 1000 }),
        (chainLength, opKind, rawIdx) => {
          // insert_no_rechain at the very end is a valid append — not tamper.
          if (opKind === 'insert_no_rechain' && rawIdx % (chainLength + 1) === chainLength) return;

          const chain = buildChain(chainLength);

          const op: TamperOp = { kind: opKind, index: rawIdx };
          const tampered = applyTamper(chain, op);

          const result = verifyChain(tampered as unknown as Record<string, unknown>[], {
            strict: true,
          });

          expect(result.valid).toBe(false);
          // The generated data is explicitly v3 and the current epoch removed
          // the legacy strict-mode reason — only CHAIN_BREAK is admissible.
          expect(result.reason).toBe('CHAIN_BREAK');
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('non-tail delete breaks the chain', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 30 }),
        fc.integer({ min: 0, max: 1000 }),
        (chainLength, rawIdx) => {
          const chain = buildChain(chainLength);
          // Delete at any position that is NOT the tail (length-1).
          const idx = rawIdx % (chainLength - 1); // 0 .. chainLength-2
          const tampered = applyTamper(chain, { kind: 'delete', index: idx });

          const result = verifyChain(tampered as unknown as Record<string, unknown>[], {
            strict: true,
          });

          expect(result.valid).toBe(false);
          expect(result.reason).toBe('CHAIN_BREAK');
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('compound tamper (mutate + reorder) is always detected', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 30 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (chainLength, mutateIdx, reorderIdx) => {
          const chain = buildChain(chainLength);

          // Apply two tampers in sequence.
          let tampered = applyTamper(chain, {
            kind: 'mutate',
            index: mutateIdx % chainLength,
          });
          tampered = applyTamper(tampered, {
            kind: 'reorder',
            index: reorderIdx % (tampered.length - 1 || 1),
          });

          const result = verifyChain(tampered as unknown as Record<string, unknown>[], {
            strict: true,
          });

          expect(result.valid).toBe(false);
          // The generated data is explicitly v3 and the current epoch removed
          // the legacy strict-mode reason — only CHAIN_BREAK is admissible.
          expect(result.reason).toBe('CHAIN_BREAK');
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('firstBreak positions at or after the tamper location', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 30 }),
        fc.integer({ min: 0, max: 1000 }),
        (chainLength, rawIdx) => {
          const chain = buildChain(chainLength);
          // Mutate a known position.
          const mutateIdx = rawIdx % chainLength;
          const tampered = applyTamper(chain, { kind: 'mutate', index: mutateIdx });

          const result = verifyChain(tampered as unknown as Record<string, unknown>[], {
            strict: true,
          });

          expect(result.valid).toBe(false);
          expect(result.reason).toBe('CHAIN_BREAK');
          expect(result.firstBreak).not.toBeNull();
          // firstBreak must point to or after the tamper position.
          expect(result.firstBreak!.index).toBeGreaterThanOrEqual(mutateIdx);
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });
});
