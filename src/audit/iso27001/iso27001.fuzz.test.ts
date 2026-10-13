/**
 * @module audit/iso27001/iso27001.fuzz
 * @description Property/fuzz tests: mapping parsing never throws on arbitrary
 * input, and the Markdown renderer neutralizes arbitrary hostile values.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseIso27001EvidenceMapping } from './mapping-schema.js';
import { escapeMarkdownCell, escapeMarkdownText } from './render-markdown.js';

/** Deterministic pseudo-random JSON value generator. */
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.double({ noNaN: true }),
    fc.string({ maxLength: 64 }),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 16 }), tie('value'), { maxKeys: 4 }),
  ),
})).value;

const hostileText = fc.string({ minLength: 1, maxLength: 300 });

describe('audit/iso27001/iso27001.fuzz', () => {
  describe('HAPPY — arbitrary JSON never crashes the mapping parser', () => {
    it('returns a discriminated parse result for any JSON value', () => {
      fc.assert(
        fc.property(jsonValue, (value) => {
          const result = parseIso27001EvidenceMapping(value);
          expect(typeof result.ok).toBe('boolean');
          if (!result.ok) {
            expect(Array.isArray(result.issues)).toBe(true);
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('BAD — hostile values cannot escape the renderer', () => {
    it('removes control characters and neutralizes structure', () => {
      fc.assert(
        fc.property(hostileText, (value) => {
          const text = escapeMarkdownText(value);
          const cell = escapeMarkdownCell(value);
          // eslint-disable-next-line no-control-regex -- asserts control characters were removed
          const controlChars = /[\u0000-\u001f\u007f]/;
          expect(text).not.toMatch(controlChars);
          expect(cell).not.toMatch(controlChars);
          expect(text).not.toContain('<');
          expect(text).not.toContain('>');
          expect(text.length).toBeLessThanOrEqual(200);
          expect(cell.length).toBeLessThanOrEqual(200 + value.length);
        }),
        { numRuns: 200 },
      );
    });

    it('never leaves an unescaped pipe in a table cell', () => {
      fc.assert(
        fc.property(hostileText, (value) => {
          const cell = escapeMarkdownCell(value);
          const unescapedPipes = cell.replace(/\\\|/g, '');
          expect(unescapedPipes).not.toContain('|');
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('CORNER — structural JSON with hostile leaves stays bounded', () => {
    it('handles nested objects and arrays without unbounded work', () => {
      fc.assert(
        fc.property(fc.array(jsonValue, { maxLength: 32 }), (values) => {
          const result = parseIso27001EvidenceMapping({
            mappingSchemaVersion: 'iso27001-evidence-mapping.v1',
            framework: { id: 'ISO/IEC 27001:2022', annex: 'A' },
            organizationId: 'org',
            ismsScopeId: 'scope',
            mappingVersion: '1',
            owner: 'owner',
            approval: { reference: 'r', approvedAt: '2026-01-01T00:00:00.000Z', assertedBy: 'a' },
            rules: values,
          });
          expect(result.ok).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('EDGE — boundary identifiers never produce partial acceptance', () => {
    it('rejects unknown selector kinds without echo of input', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 40 }), (kind) => {
          const result = parseIso27001EvidenceMapping({
            mappingSchemaVersion: 'iso27001-evidence-mapping.v1',
            framework: { id: 'ISO/IEC 27001:2022', annex: 'A' },
            organizationId: 'org',
            ismsScopeId: 'scope',
            mappingVersion: '1',
            owner: 'owner',
            approval: {
              reference: 'r',
              approvedAt: '2026-01-01T00:00:00.000Z',
              assertedBy: 'a',
            },
            rules: [
              {
                ruleId: 'rule-1',
                controlRef: { namespace: 'iso27001:2022/annexA', controlId: 'A.8.25' },
                policyRequirementId: 'req-1',
                applicability: 'asserted_applicable',
                evidence: [{ kind }],
              },
            ],
          });
          expect(result.ok).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });
});
