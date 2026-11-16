/**
 * @module adapters/persistence-audit-id-filter
 * @description Bounded probabilistic event-id membership for the append proof.
 *
 * A Bloom filter has no false negatives: `mightContain()` returning false is a
 * proof that the id was never inserted. False positives only trigger the full
 * parse/verify fallback, where exact duplicate detection remains authoritative.
 * Memory is fixed regardless of audit-history length.
 */
import { hashText } from '../shared/hashing.js';

/** 128 KiB per session; 64 cached sessions cap this structure at ~8 MiB. */
export const AUDIT_ID_FILTER_BYTES = 128 * 1024;
const AUDIT_ID_FILTER_BITS = AUDIT_ID_FILTER_BYTES * 8;

export class AuditIdFilter {
  private readonly bits = new Uint8Array(AUDIT_ID_FILTER_BYTES);

  add(id: string): void {
    assertFilterableId(id);
    for (const bit of positions(id)) {
      const byte = bit >>> 3;
      this.bits[byte] = (this.bits[byte] ?? 0) | (1 << (bit & 7));
    }
  }

  mightContain(id: string): boolean {
    assertFilterableId(id);
    for (const bit of positions(id)) {
      if (((this.bits[bit >>> 3] ?? 0) & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  }

  get byteLength(): number {
    return this.bits.length;
  }
}

function assertFilterableId(id: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    throw new TypeError('Audit id filter accepts non-empty bounded string ids only');
  }
}

/**
 * Four independent bit positions keep the false-positive rate low at the
 * 100,000-event scale while memory stays fixed. A false positive only costs a
 * full exact verification; a false negative is impossible by construction.
 */
function positions(id: string): readonly [number, number, number, number] {
  const digest = hashText(id);
  const at = (offset: number): number =>
    (Number.parseInt(digest.slice(offset, offset + 8), 16) >>> 0) % AUDIT_ID_FILTER_BITS;
  return [at(0), at(8), at(16), at(24)];
}
