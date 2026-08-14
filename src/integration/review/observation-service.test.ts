/**
 * @module integration/review/observation-service.test
 * @description Canonical line-count semantics and deterministic response
 *              digesting for repository observations.
 *
 * @test-policy HAPPY, BAD, EDGE
 */

import { describe, expect, it } from 'vitest';
import {
  buildObservationToolResponse,
  classifyRepresentation,
  lineCountOfUtf8,
  responseDigestOf,
} from './observation-service.js';

describe('lineCountOfUtf8', () => {
  it('HAPPY: canonical line count semantics (no phantom trailing line)', () => {
    expect(lineCountOfUtf8('')).toBe(0);
    expect(lineCountOfUtf8('a')).toBe(1);
    expect(lineCountOfUtf8('a\n')).toBe(1);
    expect(lineCountOfUtf8('a\nb')).toBe(2);
    expect(lineCountOfUtf8('a\nb\n')).toBe(2);
    expect(lineCountOfUtf8('\n')).toBe(1);
  });

  it('HAPPY: CRLF content counts by LF, trailing CRLF adds no phantom line', () => {
    expect(lineCountOfUtf8('a\r\nb\r\n')).toBe(2);
    expect(lineCountOfUtf8('a\r\n')).toBe(1);
  });
});

describe('classifyRepresentation', () => {
  it('HAPPY: strict UTF-8 classification is binary-safe', () => {
    expect(classifyRepresentation(Buffer.from('text'))).toBe('utf8_text');
    expect(classifyRepresentation(Buffer.from([0x00, 0xff, 0x80]))).toBe('binary');
  });
});

describe('responseDigestOf', () => {
  it('HAPPY: deterministic response payload digest', () => {
    const response = buildObservationToolResponse({
      path: 'src/foo.ts',
      revision: 'head',
      representation: 'utf8_text',
      content: 'bytes\n',
    });
    expect(responseDigestOf(response)).toBe(
      responseDigestOf(
        buildObservationToolResponse({
          path: 'src/foo.ts',
          revision: 'head',
          representation: 'utf8_text',
          content: 'bytes\n',
        }),
      ),
    );
    expect(responseDigestOf(response)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
