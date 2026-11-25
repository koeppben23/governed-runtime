/**
 * @module adapters/persistence-audit-id-filter.test
 * @description Bounded Bloom-filter membership used by the audit append proof.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_ID_FILTER_BYTES, AuditIdFilter } from './persistence-audit-id-filter.js';

describe('AuditIdFilter', () => {
  it('never reports a false negative for inserted ids', () => {
    const filter = new AuditIdFilter();
    const ids = Array.from({ length: 20_000 }, () => randomUUID());
    for (const id of ids) filter.add(id);
    for (const id of ids) expect(filter.mightContain(id)).toBe(true);
  });

  it('keeps memory fixed regardless of history length', () => {
    expect(AUDIT_ID_FILTER_BYTES).toBe(128 * 1024);
    const filter = new AuditIdFilter();
    expect(filter.byteLength).toBe(AUDIT_ID_FILTER_BYTES);
    for (let index = 0; index < 100_000; index++) filter.add(randomUUID());
    expect(filter.byteLength).toBe(AUDIT_ID_FILTER_BYTES);
  });

  it('accepts ids at the documented length boundary', () => {
    const filter = new AuditIdFilter();
    const id = 'x'.repeat(256);
    filter.add(id);
    expect(filter.mightContain(id)).toBe(true);
  });

  it('reports an id that was never inserted as absent', () => {
    const filter = new AuditIdFilter();
    filter.add(randomUUID());
    expect(filter.mightContain(randomUUID())).toBe(false);
  });

  it('rejects empty and unbounded ids instead of silently ignoring them', () => {
    const filter = new AuditIdFilter();
    expect(() => filter.add('')).toThrow(/non-empty bounded string/i);
    expect(() => filter.mightContain('')).toThrow(/non-empty bounded string/i);
    expect(() => filter.add('x'.repeat(257))).toThrow(/non-empty bounded string/i);
    expect(() => filter.add(42 as unknown as string)).toThrow(/non-empty bounded string/i);
  });
});
