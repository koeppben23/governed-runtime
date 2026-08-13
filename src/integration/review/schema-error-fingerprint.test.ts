/**
 * @module schema-error-fingerprint.test
 * @description Canonical repair fingerprint: identical issue sets fingerprint
 *              identically regardless of ordering; different sets differ.
 *
 * @test-policy HAPPY, BAD
 */

import { describe, expect, it } from 'vitest';
import { schemaErrorFingerprintOf } from './schema-error-fingerprint.js';

const KEY_A = {
  path: 'majorRisks.0.relation.subjectAnchors.0.location',
  code: 'unrecognized_keys',
  message: 'Unrecognized key: "reviewedBy"',
};
const KEY_B = {
  path: 'blockingIssues.2.relation.evidenceLocations.0',
  code: 'unrecognized_keys',
  message: 'Unrecognized key: "reviewedBy"',
};

describe('schemaErrorFingerprintOf', () => {
  it('HAPPY: identical issue sets fingerprint identically regardless of ordering', () => {
    const first = schemaErrorFingerprintOf([KEY_A, KEY_B]);
    const second = schemaErrorFingerprintOf([KEY_B, KEY_A]);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it('HAPPY: duplicate issues are order-stable and idempotent', () => {
    expect(schemaErrorFingerprintOf([KEY_A, KEY_A, KEY_B])).toBe(
      schemaErrorFingerprintOf([KEY_B, KEY_A]),
    );
  });

  it('BAD: different error sets produce different fingerprints', () => {
    const changed = schemaErrorFingerprintOf([{ ...KEY_A, path: 'other.0.path' }]);
    expect(changed).not.toBe(schemaErrorFingerprintOf([KEY_A]));
  });

  it('BAD: empty or absent issue sets have no fingerprint (fail safe)', () => {
    expect(schemaErrorFingerprintOf([])).toBeNull();
    expect(schemaErrorFingerprintOf(undefined)).toBeNull();
  });
});
