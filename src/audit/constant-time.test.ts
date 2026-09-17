/**
 * @module audit/constant-time.test
 * @description Functional contract tests for `constantTimeBytesEqual`.
 *
 * Scope note: these tests prove the comparison SEMANTICS (equality,
 * inequality, length folding, edge cases). They do not and cannot prove that
 * the implementation is timing-side-channel free; mutation coverage of this
 * branch logic is semantic evidence only.
 */

import { describe, expect, it } from 'vitest';
import { constantTimeBytesEqual } from './constant-time.js';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('constantTimeBytesEqual semantics', () => {
  it('returns true for identical byte sequences', () => {
    expect(constantTimeBytesEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
  });

  it('returns true for two empty inputs', () => {
    expect(constantTimeBytesEqual(bytes(), bytes())).toBe(true);
  });

  it('returns true for all-zero sequences', () => {
    expect(constantTimeBytesEqual(bytes(0, 0, 0), bytes(0, 0, 0))).toBe(true);
  });

  it('returns false on a first-byte difference', () => {
    expect(constantTimeBytesEqual(bytes(1, 2, 3), bytes(9, 2, 3))).toBe(false);
  });

  it('returns false on a last-byte difference', () => {
    expect(constantTimeBytesEqual(bytes(1, 2, 3), bytes(1, 2, 4))).toBe(false);
  });

  it('folds length differences into the result', () => {
    expect(constantTimeBytesEqual(bytes(), bytes(0))).toBe(false);
    expect(constantTimeBytesEqual(bytes(1, 2), bytes(1, 2, 0))).toBe(false);
    expect(constantTimeBytesEqual(bytes(1, 2, 3), bytes(1, 2))).toBe(false);
  });

  it('treats 0 and 255 as distinct byte values', () => {
    expect(constantTimeBytesEqual(bytes(255), bytes(0))).toBe(false);
    expect(constantTimeBytesEqual(bytes(255, 0), bytes(255, 0))).toBe(true);
  });

  it('compares every byte position of longer inputs', () => {
    const left = bytes(...Array.from({ length: 64 }, (_, index) => index % 256));
    const right = bytes(...Array.from({ length: 64 }, (_, index) => index % 256));
    expect(constantTimeBytesEqual(left, right)).toBe(true);

    right[63] = (right[63]! + 1) % 256;
    expect(constantTimeBytesEqual(left, right)).toBe(false);
  });
});
