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
});
