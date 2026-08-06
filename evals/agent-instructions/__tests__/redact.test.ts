import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../redact.js';

describe('redactSecrets', () => {
  it('redacts a known secret', () => {
    expect(redactSecrets('hello world', ['world'])).toBe('hello world');
    // world is only 5 chars, below the 8-char minimum
  });

  it('redacts secrets >= 8 characters', () => {
    expect(redactSecrets('hello mysecret123', ['mysecret123'])).toBe(
      'hello ***REDACTED***',
    );
  });

  it('ignores secrets shorter than 8 characters', () => {
    expect(redactSecrets('api key sk-123', ['sk-123'])).toBe(
      'api key sk-123',
    );
  });

  it('sorts longest-first to avoid partial matches', () => {
    // 'abcdefgh' (8) < 'abcdefghij' (10) — longer should be replaced first
    expect(
      redactSecrets('x abcdefghij y', ['abcdefgh', 'abcdefghij']),
    ).toBe('x ***REDACTED*** y');
  });

  it('deduplicates secret values', () => {
    expect(
      redactSecrets('a secret123 b', ['secret123', 'secret123']),
    ).toBe('a ***REDACTED*** b');
  });

  it('returns unchanged text for empty secrets list', () => {
    expect(redactSecrets('hello', [])).toBe('hello');
  });

  it('handles empty text', () => {
    expect(redactSecrets('', ['mysecret123'])).toBe('');
  });
});
