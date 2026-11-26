import { describe, expect, it } from 'vitest';
import { assertExpectedCommit } from '../onboarding-smoke.mjs';

const actual = '0123456789abcdef0123456789abcdef01234567';

describe('onboarding smoke expected SHA', () => {
  it('does not require an expectation for an exploratory run', () => {
    expect(() => assertExpectedCommit(actual, undefined)).not.toThrow();
  });

  it('accepts the exact full commit SHA case-insensitively', () => {
    expect(() => assertExpectedCommit(actual, actual.toUpperCase())).not.toThrow();
  });

  it('fails closed when the branch moved to another commit', () => {
    expect(() => assertExpectedCommit(actual, 'fedcba9876543210fedcba9876543210fedcba98')).toThrow(
      /expected commit .* but the clone checked out/,
    );
  });

  it('rejects a short SHA instead of accepting an ambiguous prefix', () => {
    expect(() => assertExpectedCommit(actual, actual.slice(0, 12))).toThrow(
      /full 40-character hexadecimal commit SHA/,
    );
  });
});
