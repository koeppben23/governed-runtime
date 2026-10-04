/**
 * @module presentation/reason-copy
 * @description Completeness guard for the canonical reason-copy table.
 *
 * The copy table is the single migrated-reason-code authority. These tests
 * keep it consistent with the canonical reason registry so a copy entry can
 * never reference an unregistered code or lose the registry-verbatim message.
 */

import { describe, expect, it } from 'vitest';
import { defaultReasonRegistry } from '../config/reasons.js';
import { projectReasonFromRegistry } from './reason-projection.js';
import { REASON_COPY, isMigratedReasonCode, lookupReasonCopy } from './reason-copy.js';

describe('REASON_COPY completeness', () => {
  it('has no duplicate codes', () => {
    const codes = REASON_COPY.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every copy code is registered in the canonical reason registry', () => {
    for (const entry of REASON_COPY) {
      expect(defaultReasonRegistry.get(entry.code)).not.toBeUndefined();
      expect(defaultReasonRegistry.format(entry.code, {}).recovery.length).toBeGreaterThan(0);
    }
  });

  it('copy headline and explanation are context-free (no placeholders)', () => {
    for (const entry of REASON_COPY) {
      expect(entry.headline).not.toMatch(/[{}]/);
      expect(entry.explanation).not.toMatch(/[{}]/);
      expect(entry.headline.trim().length).toBeGreaterThan(0);
      expect(entry.explanation.trim().length).toBeGreaterThan(0);
    }
  });

  it('every migrated code projects with a canonicalMessage preserved', () => {
    for (const entry of REASON_COPY) {
      const projection = projectReasonFromRegistry(entry.code)!;
      expect(projection).not.toBeNull();
      expect(projection.canonicalMessage).toBeDefined();
      expect(projection.canonicalMessage).toContain(
        defaultReasonRegistry.format(entry.code, {}).reason,
      );
      expect(projection.explanation).toBe(entry.explanation);
      expect(projection.impact).toBe(entry.impact);
    }
  });

  it('isMigratedReasonCode and lookupReasonCopy agree with the copy table', () => {
    for (const entry of REASON_COPY) {
      expect(isMigratedReasonCode(entry.code)).toBe(true);
      expect(lookupReasonCopy(entry.code)?.headline).toBe(entry.headline);
    }
    expect(isMigratedReasonCode('NOT_A_REGISTERED_CODE')).toBe(false);
    expect(lookupReasonCopy('PLAN_REQUIRED')).toBeUndefined();
  });
});
