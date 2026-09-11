import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../redact.js';

describe('redactSecrets', () => {
  it('redacts explicitly declared short and long secrets', () => {
    expect(redactSecrets('hello world', ['world'])).toBe('hello ***REDACTED***');
    expect(redactSecrets('api key sk-1', ['sk-1'])).toBe('api key ***REDACTED***');
    expect(redactSecrets('hello mysecret123', ['mysecret123'])).toBe(
      'hello ***REDACTED***',
    );
  });

  it('sorts longest-first to avoid partial matches', () => {
    expect(redactSecrets('x abcdefghij y', ['abcdefgh', 'abcdefghij'])).toBe(
      'x ***REDACTED*** y',
    );
  });

  it('deduplicates secret values', () => {
    expect(redactSecrets('a secret123 b', ['secret123', 'secret123'])).toBe(
      'a ***REDACTED*** b',
    );
  });

  it('ignores only empty secret values', () => {
    expect(redactSecrets('hello', ['', 'hello'])).toBe('***REDACTED***');
  });

  it('returns unchanged text for empty secrets list', () => {
    expect(redactSecrets('hello', [])).toBe('hello');
  });

  it('handles empty text', () => {
    expect(redactSecrets('', ['secret'])).toBe('');
  });
});
