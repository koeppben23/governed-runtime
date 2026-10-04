/**
 * @module presentation/labels.test
 * @description Tests for label normalisation.
 */
import { describe, it, expect } from 'vitest';
import { STATUS_LABELS, lookupStatusLabel, parseStatusLabel } from './labels.js';
import { PresentationContractError } from './model.js';

const ALL_INPUTS = [
  'BLOCKED',
  'READY_WITH_WARNINGS',
  'CHANGES_REQUIRED',
  'NOT_VERIFIED',
  'IN_PROGRESS',
  'READY',
] as const;

describe('STATUS_LABELS', () => {
  it('has a label for every known input (exhaustiveness)', () => {
    for (const input of ALL_INPUTS) {
      expect(STATUS_LABELS[input], `Missing label for "${input}"`).toBeTypeOf('string');
      expect(STATUS_LABELS[input].length, `Label for "${input}" is empty`).toBeGreaterThan(0);
    }
  });

  it('no label is SCREAMING_SNAKE_CASE', () => {
    const screaming = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
    for (const [key, label] of Object.entries(STATUS_LABELS)) {
      expect(screaming.test(label), `"${key}" → "${label}" is SCREAMING_SNAKE_CASE`).toBe(false);
    }
  });

  it('label count matches input count', () => {
    expect(Object.keys(STATUS_LABELS)).toHaveLength(ALL_INPUTS.length);
  });

  it('each known input maps to the correct product-oriented label', () => {
    expect(STATUS_LABELS.BLOCKED).toBe('Blocked');
    expect(STATUS_LABELS.READY_WITH_WARNINGS).toBe('Ready with warnings');
    expect(STATUS_LABELS.CHANGES_REQUIRED).toBe('Changes required');
    expect(STATUS_LABELS.NOT_VERIFIED).toBe('Not verified');
    expect(STATUS_LABELS.IN_PROGRESS).toBe('In progress');
    expect(STATUS_LABELS.READY).toBe('Ready');
  });
});

describe('lookupStatusLabel', () => {
  it('resolves every known input', () => {
    for (const input of ALL_INPUTS) {
      expect(() => lookupStatusLabel(input)).not.toThrow();
    }
  });

  it('returns the correct label for each input', () => {
    expect(lookupStatusLabel('BLOCKED')).toBe('Blocked');
    expect(lookupStatusLabel('READY')).toBe('Ready');
  });
});

describe('parseStatusLabel', () => {
  it('resolves every known input', () => {
    for (const input of ALL_INPUTS) {
      const result = parseStatusLabel(input);
      expect(result).toBe(lookupStatusLabel(input));
    }
  });

  it('rejects unknown input', () => {
    expect(() => parseStatusLabel('UNKNOWN_FOO')).toThrow(PresentationContractError);
  });

  it('error message lists known values', () => {
    try {
      parseStatusLabel('UNKNOWN_FOO');
    } catch (e) {
      expect(String(e)).toContain('UNKNOWN_FOO');
      expect(String(e)).toContain('BLOCKED');
    }
  });
});
