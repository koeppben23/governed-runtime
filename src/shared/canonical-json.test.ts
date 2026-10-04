import { describe, it, expect } from 'vitest';
import { canonicalJsonStringify } from './canonical-json.js';

/**
 * @module shared/canonical-json.test
 * @description The single canonical JSON serialization authority. These tests
 * pin the EXACT output strings so any future change to the serializer is caught
 * — this is the byte-identity basis for unifying the previously-duplicated audit
 * and discovery serializers onto one authority without changing any persisted
 * digest.
 */

describe('canonicalJsonStringify', () => {
  it('sorts object keys lexicographically at every depth', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJsonStringify({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('preserves array order (order is semantic) and recurses elements', () => {
    expect(canonicalJsonStringify([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });

  it('is insertion-order independent for structurally equal objects', () => {
    expect(canonicalJsonStringify({ a: 1, b: 2 })).toBe(canonicalJsonStringify({ b: 2, a: 1 }));
  });

  it('returns primitives unchanged', () => {
    expect(canonicalJsonStringify(42)).toBe('42');
    expect(canonicalJsonStringify('x')).toBe('"x"');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(null)).toBe('null');
  });

  // ─── Byte-identity lock-in: the exact cases that drove the unification ─────────
  // The prior audit serializer skipped undefined object props before serializing;
  // the prior discovery serializer kept them. JSON.stringify neutralizes the
  // difference. These frozen strings prove the unified body matches both.

  it('drops object properties whose value is undefined', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('serializes an object of only-undefined properties as {}', () => {
    expect(canonicalJsonStringify({ a: undefined, b: undefined })).toBe('{}');
  });

  it('converts undefined array elements to null', () => {
    expect(canonicalJsonStringify({ arr: [1, undefined, 3] })).toBe('{"arr":[1,null,3]}');
    expect(canonicalJsonStringify([undefined])).toBe('[null]');
  });

  it('converts sparse array holes to null', () => {
    const sparse: number[] = [1];
    sparse[2] = 3;
    expect(canonicalJsonStringify({ arr: sparse })).toBe('{"arr":[1,null,3]}');
  });

  it('handles nested undefined inside array-of-objects', () => {
    expect(canonicalJsonStringify({ k: [{ b: undefined, a: 1 }] })).toBe('{"k":[{"a":1}]}');
  });

  it('preserves defined falsey object properties while dropping only undefined', () => {
    expect(canonicalJsonStringify({ a: 0, b: false, c: '', d: null, e: undefined })).toBe(
      '{"a":0,"b":false,"c":"","d":null}',
    );
  });

  it('serializes top-level undefined the same as JSON.stringify (undefined)', () => {
    // JSON.stringify(undefined) === undefined (not a string). Lock the behaviour in.
    expect(canonicalJsonStringify(undefined)).toBeUndefined();
  });
});
