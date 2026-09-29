/**
 * @module state/risk-declaration.test
 * @description Canonical ticket risk declaration: deterministic parsing,
 * integrity verification and the single effective task-class resolution.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';

import { hashText } from '../shared/hashing.js';
import {
  parseTicketRiskDeclaration,
  resolveEffectiveTaskClass,
  ticketRiskDeclarationFloor,
  verifyTicketRiskDeclarationIntegrity,
} from './risk-declaration.js';

describe('parseTicketRiskDeclaration', () => {
  it('HAPPY: parses each canonical class with the documented key variants', () => {
    expect(parseTicketRiskDeclaration('Risk: TRIVIAL')).toEqual({
      kind: 'declared',
      taskClass: 'TRIVIAL',
    });
    expect(parseTicketRiskDeclaration('Risikoklasse: STANDARD')).toEqual({
      kind: 'declared',
      taskClass: 'STANDARD',
    });
    expect(parseTicketRiskDeclaration('**Risk Class:** HIGH-RISK')).toEqual({
      kind: 'declared',
      taskClass: 'HIGH-RISK',
    });
    expect(parseTicketRiskDeclaration('- Risk: high risk')).toEqual({
      kind: 'declared',
      taskClass: 'HIGH-RISK',
    });
  });

  it('HAPPY: accepts trailing rationale after the class token', () => {
    expect(parseTicketRiskDeclaration('Risk: TRIVIAL — docs-only change')).toEqual({
      kind: 'declared',
      taskClass: 'TRIVIAL',
    });
  });

  it('HAPPY: no declaration line means absent', () => {
    expect(
      parseTicketRiskDeclaration('Fix the null check in updateTask.\n\nNo risk line.'),
    ).toEqual({
      kind: 'absent',
    });
  });

  it('BAD: prose mentioning a class does not count as a declaration', () => {
    expect(
      parseTicketRiskDeclaration('This is not a Risk: TRIVIAL statement because it is mid-line.'),
    ).toEqual({ kind: 'absent' });
  });

  it('BAD: mixed valid declaration kinds are a conflict', () => {
    expect(parseTicketRiskDeclaration('Risk: TRIVIAL\nRisk: HIGH-RISK')).toEqual({
      kind: 'conflict',
      values: ['HIGH-RISK', 'TRIVIAL'],
    });
  });

  it('BAD: an unparseable value makes the whole declaration invalid', () => {
    expect(parseTicketRiskDeclaration('Risk: HIGH')).toEqual({
      kind: 'invalid',
      raw: 'HIGH',
    });
  });

  it('BAD: a token that merely starts with a class name is invalid', () => {
    expect(parseTicketRiskDeclaration('Risk: STANDARDIZED')).toEqual({
      kind: 'invalid',
      raw: 'STANDARDIZED',
    });
    expect(parseTicketRiskDeclaration('Risk: TRIVIALITY')).toEqual({
      kind: 'invalid',
      raw: 'TRIVIALITY',
    });
  });

  it('BAD: a valid plus an invalid line is invalid (never silently partial)', () => {
    expect(parseTicketRiskDeclaration('Risk: TRIVIAL\nRisk: low')).toEqual({
      kind: 'invalid',
      raw: 'low',
    });
  });

  it('BAD: an explicit declaration without a value is invalid, with or without whitespace', () => {
    expect(parseTicketRiskDeclaration('Risk:')).toEqual({
      kind: 'invalid',
      raw: '(no value)',
    });
    expect(parseTicketRiskDeclaration('Risk:   ')).toEqual({
      kind: 'invalid',
      raw: '(no value)',
    });
    expect(parseTicketRiskDeclaration('Risikoklasse =')).toEqual({
      kind: 'invalid',
      raw: '(no value)',
    });
  });

  it('HAPPY: fenced code examples are not binding declarations', () => {
    const text = [
      'Example usage:',
      '',
      '```markdown',
      'Risk: HIGH',
      '```',
      '',
      'Risk: TRIVIAL',
    ].join('\n');
    expect(parseTicketRiskDeclaration(text)).toEqual({
      kind: 'declared',
      taskClass: 'TRIVIAL',
    });
  });

  it('HAPPY: tilde fences and quoted blockquote examples are not binding', () => {
    const text = [
      '~~~',
      '- Risk: STANDARD',
      '~~~',
      '',
      '> Risk: HIGH-RISK',
      '',
      'No binding declaration here.',
    ].join('\n');
    expect(parseTicketRiskDeclaration(text)).toEqual({ kind: 'absent' });
  });

  it('BAD: indented code examples are not binding declarations', () => {
    expect(parseTicketRiskDeclaration('    Risk: STANDARD')).toEqual({ kind: 'absent' });
    expect(parseTicketRiskDeclaration('\tRisk: HIGH')).toEqual({ kind: 'absent' });
    const mixed = ['    Risk: STANDARD', '', 'Risk: TRIVIAL'].join('\n');
    expect(parseTicketRiskDeclaration(mixed)).toEqual({
      kind: 'declared',
      taskClass: 'TRIVIAL',
    });
  });

  it('BAD: an indented fence opener does not hide a real declaration', () => {
    // Four spaces make the backtick line an indented code block, not a fence.
    const text = ['    ```example', 'Risk: HIGH-RISK', '```'].join('\n');
    expect(parseTicketRiskDeclaration(text)).toEqual({
      kind: 'declared',
      taskClass: 'HIGH-RISK',
    });
  });

  it('EDGE: an info-string lookalike does not close an open fence', () => {
    const text = ['```text', '```js', 'Risk: STANDARD', '```', '', 'Risk: TRIVIAL'].join('\n');
    expect(parseTicketRiskDeclaration(text)).toEqual({
      kind: 'declared',
      taskClass: 'TRIVIAL',
    });
  });

  it('EDGE: an unclosed fence suppresses the rest of the document', () => {
    const text = ['```', 'Risk: HIGH', 'Risk: TRIVIAL'].join('\n');
    expect(parseTicketRiskDeclaration(text)).toEqual({ kind: 'absent' });
  });

  it('CORNER: repeated identical declarations collapse to one class', () => {
    expect(parseTicketRiskDeclaration('Risk: STANDARD\nRisk: STANDARD')).toEqual({
      kind: 'declared',
      taskClass: 'STANDARD',
    });
  });
});

describe('ticketRiskDeclarationFloor', () => {
  it('EDGE: declared and conflict contribute a floor, absent/invalid do not', () => {
    expect(ticketRiskDeclarationFloor({ kind: 'declared', taskClass: 'STANDARD' })).toBe(
      'STANDARD',
    );
    expect(ticketRiskDeclarationFloor({ kind: 'conflict', values: ['TRIVIAL', 'HIGH-RISK'] })).toBe(
      'HIGH-RISK',
    );
    expect(ticketRiskDeclarationFloor({ kind: 'absent' })).toBeNull();
    expect(ticketRiskDeclarationFloor({ kind: 'invalid', raw: 'HIGH' })).toBeNull();
  });
});

describe('resolveEffectiveTaskClass', () => {
  it('HAPPY: computed class governs when nothing else is declared', () => {
    expect(
      resolveEffectiveTaskClass({ computed: 'TRIVIAL', declaration: { kind: 'absent' } }),
    ).toBe('TRIVIAL');
  });

  it('EDGE: ticket floor and escalation can only raise the computed class', () => {
    expect(
      resolveEffectiveTaskClass({
        computed: 'TRIVIAL',
        declaration: { kind: 'declared', taskClass: 'STANDARD' },
      }),
    ).toBe('STANDARD');
    expect(
      resolveEffectiveTaskClass({
        computed: 'TRIVIAL',
        declaration: { kind: 'absent' },
        escalated: 'HIGH-RISK',
      }),
    ).toBe('HIGH-RISK');
    // Nothing can lower a higher computed class.
    expect(
      resolveEffectiveTaskClass({
        computed: 'HIGH-RISK',
        declaration: { kind: 'declared', taskClass: 'TRIVIAL' },
        escalated: 'TRIVIAL',
      }),
    ).toBe('HIGH-RISK');
  });
});

describe('verifyTicketRiskDeclarationIntegrity', () => {
  const text = 'Risk: TRIVIAL\n\nDocs only.';
  const valid = {
    text,
    digest: hashText(text),
    riskDeclaration: parseTicketRiskDeclaration(text),
  };

  it('HAPPY: accepts the parser result over the stored text', () => {
    expect(verifyTicketRiskDeclarationIntegrity(valid)).toBe(true);
  });

  it('BAD: a digest that does not hash the text fails', () => {
    expect(verifyTicketRiskDeclarationIntegrity({ ...valid, digest: 'other' })).toBe(false);
  });

  it('BAD: a declaration that does not match the parser result fails', () => {
    expect(
      verifyTicketRiskDeclarationIntegrity({
        ...valid,
        riskDeclaration: { kind: 'declared', taskClass: 'STANDARD' },
      }),
    ).toBe(false);
  });
});
