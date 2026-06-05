/**
 * @module audit/__tests__/tamper-evidence-harness
 * @description Shared, deterministic harness for the audit tamper-evidence
 * property tests (#435). It is intentionally **fast-check-free** and lives under
 * `__tests__/` (excluded from the build/dist via tsconfig + eslint test scope)
 * so it is test-only code, never shipped, yet importable by BOTH the unit
 * property test (`tamper-evidence.property.test.ts`, gates `npm test`) and the
 * deep fuzz test (`tamper-evidence.fuzz.test.ts`, nightly). fast-check wiring
 * lives only in those test files (fast-check is a devDependency).
 *
 * SSOT discipline: this harness performs NO hashing of its own. Every chain /
 * digest / serialization decision is delegated to the production authorities —
 * `canonicalJsonStringify`, `computeChainHash`, `computeCanonicalEventDigest`,
 * and `verifyChain`. The harness only (a) builds realistic events through the
 * real factory sink, (b) enumerates leaf paths, (c) mutates one leaf to a
 * guaranteed-different value, and (d) deep-reorders object keys.
 *
 * Property layers exercised (kept strictly separate — see the test files):
 *   P-A  (C1): any single-leaf mutation (incl. nested + array elements,
 *              including chainHash/prevHash) ⇒ verifyChain fails.
 *   P-B  (C2): mutation of a NON-excluded content leaf ⇒ canonical event digest
 *              changes (⇒ the stamped messageImprint would mismatch).
 *   P-B' (C2): mutation of an EXCLUDED field ⇒ canonical event digest unchanged
 *              (those fields are guarded by the chain hash, not the imprint).
 *   P-C  (S1): deep object-key reorder (arrays untouched) ⇒ canonical
 *              serialization, chain hash, and digest are all identical and the
 *              chain still verifies.
 */

import {
  GENESIS_HASH,
  finalizeWithTimestampEvidence,
  computeChainHash,
  type ChainedAuditEvent,
  type EventBody,
} from '../types.js';
import { canonicalJsonStringify, computeCanonicalEventDigest } from '../canonical-digest.js';
import { verifyChain } from '../integrity.js';
import type { TimestampEvidence } from '../../state/evidence.js';

/**
 * Test-side characterization of the production authority's excluded set
 * (`canonical-digest.ts` module-private `EXCLUDED_FIELDS`). This is NOT a second
 * runtime authority: it is only used to PARTITION generated mutation paths into
 * the C2-content (P-B) vs C2-excluded (P-B') cases. Any drift from the real set
 * is caught automatically — P-B fails if a now-excluded field stops changing
 * the digest, and P-B' fails if a now-included field starts changing it.
 */
export const IMPRINT_EXCLUDED_FIELDS: readonly string[] = [
  'chainHash',
  'prevHash',
  'canonicalEventDigest',
  'timestampEvidence',
];

/** Re-export for test ergonomics (the events the harness produces and checks). */
export type ChainedAuditEventForTest = ChainedAuditEvent;

/** A path into a nested value: object keys (string) and array indices (number). */
export type PathSegment = string | number;
export type Path = readonly PathSegment[];

/**
 * Plain, fast-check-driven inputs for a realistic chained audit event. Kept as
 * primitives/arrays so the (fast-check-free) harness stays generator-agnostic;
 * the test files supply arbitraries for these.
 */
export interface RichEventParams {
  readonly idHex: string; // 12 hex chars → deterministic UUID tail
  readonly phase: string;
  readonly eventName: string;
  readonly minute: number; // 0..59 → deterministic timestamp
  readonly actor: string;
  readonly rationale: string; // nested detail leaf (string)
  readonly decisionSequence: number; // nested detail leaf (number)
  readonly autoAdvanced: boolean; // nested detail leaf (boolean)
  readonly audience: readonly string[]; // actorInfo.verificationMeta.audience (ARRAY of leaves)
  readonly issuer: string;
}

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIXED_RECEIVED_AT = '2026-01-01T00:00:00.000Z';

/** Deterministic UUID from a 12-hex tail (reproducible counterexamples). */
function makeId(idHex: string): string {
  const tail = idHex
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '0')
    .padStart(12, '0')
    .slice(-12);
  return `00000000-0000-4000-8000-${tail}`;
}

function makeTimestamp(minute: number): string {
  const mm = String(((minute % 60) + 60) % 60).padStart(2, '0');
  return `2026-01-01T00:${mm}:00.000Z`;
}

/**
 * Build a realistic, deeply-nested chained audit event through the production
 * factory sink (`finalizeWithTimestampEvidence`), so chainHash, canonical
 * digest, and the stamped TSA messageImprint are all authority-computed.
 *
 * The event deliberately includes nesting and an array so leaf enumeration
 * covers depth and array elements:
 *   detail.decision.{rationale,sequence,autoAdvanced}   (nested object)
 *   detail.tags[]                                       (array of scalars)
 *   actorInfo.verificationMeta.audience[]               (array of scalars, depth 3)
 *   timestampEvidence.tsa.* + canonicalEventDigest      (EXCLUDED fields present)
 */
export function buildRichEvent(
  p: RichEventParams,
  prevHash: string = GENESIS_HASH,
): ChainedAuditEvent {
  const body: EventBody = {
    id: makeId(p.idHex),
    sessionId: SESSION_ID,
    phase: p.phase,
    event: p.eventName,
    timestamp: makeTimestamp(p.minute),
    actor: p.actor,
    auditFormatVersion: 'audit-chain.v2',
    actorInfo: {
      id: 'operator-1',
      email: null,
      source: 'oidc',
      assurance: 'idp_verified',
      verificationMeta: {
        issuer: p.issuer,
        audience: [...p.audience],
        keyId: 'key-1',
        algorithm: 'RS256',
        verifiedAt: FIXED_RECEIVED_AT,
      },
    },
    detail: {
      kind: 'decision',
      decision: {
        rationale: p.rationale,
        sequence: p.decisionSequence,
        autoAdvanced: p.autoAdvanced,
      },
      tags: [...p.audience],
    },
    prevHash,
  };

  const timestampEvidence: TimestampEvidence = {
    status: 'tsa_verified',
    source: 'tsa',
    resolvedAt: FIXED_RECEIVED_AT,
    tsa: {
      tokenDerBase64: 'AA==',
      receivedAt: FIXED_RECEIVED_AT,
      verificationStatus: 'valid',
    },
  };

  return finalizeWithTimestampEvidence(body, prevHash, timestampEvidence);
}

/**
 * Enumerate every LEAF path of a JSON-compatible value: scalars (string,
 * number, boolean, null) at any depth, including array elements. Object/array
 * containers are not returned as leaves — mutation targets concrete leaves so
 * the test remains semantically meaningful (a real field value changes).
 */
export function collectLeafPaths(value: unknown, prefix: Path = []): Path[] {
  if (Array.isArray(value)) {
    return value.flatMap((el, i) => collectLeafPaths(el, [...prefix, i]));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      collectLeafPaths(v, [...prefix, k]),
    );
  }
  return [prefix];
}

function getAtPath(value: unknown, path: Path): unknown {
  let cur: unknown = value;
  for (const seg of path) {
    cur = (cur as Record<PathSegment, unknown>)[seg];
  }
  return cur;
}

/** A value guaranteed to differ (by JSON value) from `old`. */
export function mutateToDifferent(old: unknown): unknown {
  if (typeof old === 'string') return old + '~tampered';
  if (typeof old === 'number') return old + 1;
  if (typeof old === 'boolean') return !old;
  // null / anything else → a concrete, non-equal sentinel.
  return '__tampered__';
}

/** Immutably set a single leaf at `path` to `next` (structural clone along path). */
export function setAtPath<T>(root: T, path: Path, next: unknown): T {
  if (path.length === 0) return next as T;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[head as number] = setAtPath(copy[head as number], rest, next);
    return copy as unknown as T;
  }
  const obj = root as Record<PathSegment, unknown>;
  return { ...obj, [head!]: setAtPath(obj[head!], rest, next) } as T;
}

/**
 * Mutate exactly the leaf at `path` to a guaranteed-different value. Returns a
 * new event; the original is untouched.
 */
export function mutateLeaf(event: ChainedAuditEvent, path: Path): ChainedAuditEvent {
  const current = getAtPath(event, path);
  return setAtPath(event, path, mutateToDifferent(current));
}

/**
 * Deep-clone with object keys recursively reordered (reversed) but ARRAY ORDER
 * PRESERVED. Reordering array elements would be a semantic mutation, not a
 * canonicalization no-op, so arrays are cloned in place.
 */
export function deepReorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepReorderKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = deepReorderKeys(v);
    return out;
  }
  return value;
}

// ─── SSOT-delegating property checks (no assertions; return facts) ──────────────

/** True iff the path's root field is excluded from the C2 imprint digest. */
export function isExcludedPath(path: Path): boolean {
  return path.length > 0 && IMPRINT_EXCLUDED_FIELDS.includes(String(path[0]));
}

/**
 * P-A (C1): a single-event chain with one leaf mutated must fail verifyChain.
 * Uses the production verifier; covers all leaves incl. chainHash/prevHash.
 */
export function mutatedChainVerifies(event: ChainedAuditEvent, path: Path): boolean {
  const tampered = mutateLeaf(event, path);
  return verifyChain([tampered as unknown as Record<string, unknown>], { strict: true }).valid;
}

/** Baseline: an untampered single-event chain must verify. */
export function pristineChainVerifies(event: ChainedAuditEvent): boolean {
  return verifyChain([event as unknown as Record<string, unknown>], { strict: true }).valid;
}

/** C2 digest of an event (the value a TSA stamps as messageImprint). */
export function imprintDigest(event: ChainedAuditEvent): string {
  return computeCanonicalEventDigest(event as unknown as Record<string, unknown>);
}

/** Canonical serialization of an arbitrary value (S1 authority). */
export function canonical(value: unknown): string {
  return canonicalJsonStringify(value);
}

/** Recompute the chain hash for an event body (authority), for P-C equality. */
export function chainHashOf(event: ChainedAuditEvent): string {
  const { chainHash: _omit, ...body } = event;
  return computeChainHash(event.prevHash, body);
}
