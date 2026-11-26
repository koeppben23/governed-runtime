import { describe, expect, it } from 'vitest';
import { JSON_OBJECT_BYTE_LIMIT, parseStrictJsonObject } from './strict-json-object.js';

describe('strict model JSON boundary', () => {
  it('accepts a complete object with surrounding JSON whitespace', () => {
    expect(parseStrictJsonObject(' \n{"value": [1, true, null]}\t')).toEqual({
      kind: 'ok',
      value: { value: [1, true, null] },
    });
  });
  it.each([
    '[]',
    'null',
    '{} {}',
    'prefix {}',
    '{} suffix',
    '```json\n{}\n```',
    '{"x":1,}',
    '{/*comment*/}',
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '{"x":{"y":1,"y":2}}',
    '{"x":1e400}',
    '{"x":NaN}',
    '',
  ])('rejects %s', (text) => {
    expect(parseStrictJsonObject(text).kind).toBe('invalid');
  });
  it('bounds UTF-8 bytes and nesting before constructing the object', () => {
    expect(
      parseStrictJsonObject(JSON.stringify({ x: 'é'.repeat(JSON_OBJECT_BYTE_LIMIT / 2) })).kind,
    ).toBe('invalid');
    expect(parseStrictJsonObject('{"x":'.repeat(65) + '0' + '}'.repeat(65)).kind).toBe('invalid');
  });

  it('accepts exactly the byte boundary but rejects one additional UTF-8 byte', () => {
    const exact = JSON.stringify({ x: 'a'.repeat(JSON_OBJECT_BYTE_LIMIT - 8) });
    expect(Buffer.byteLength(exact, 'utf8')).toBe(JSON_OBJECT_BYTE_LIMIT);
    expect(parseStrictJsonObject(exact).kind).toBe('ok');
    expect(parseStrictJsonObject(exact + ' ').kind).toBe('invalid');
  });

  it.each([0, []])('bounds large collections of literal or container values (%j)', (value) => {
    // One root object + one array + 99,998 entries = 100,000 values.
    const exact = JSON.stringify({ values: Array.from({ length: 99_998 }, () => value) });
    expect(parseStrictJsonObject(exact).kind).toBe('ok');
    expect(
      parseStrictJsonObject(JSON.stringify({ values: Array.from({ length: 99_999 }, () => value) }))
        .kind,
    ).toBe('invalid');
  });

  it.each(['1', 'true', 'false', '"plain string"'])('rejects a scalar root: %s', (text) => {
    expect(parseStrictJsonObject(text).kind).toBe('invalid');
  });
});
