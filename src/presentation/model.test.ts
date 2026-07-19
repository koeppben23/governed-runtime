/**
 * @module presentation/model.test
 * @description Tests for normalizedMarkdown, validateCodeLanguage, and PresentationContractError.
 */
import { describe, it, expect } from 'vitest';
import { normalizedMarkdown, validateCodeLanguage, PresentationContractError } from './model.js';

describe('normalizedMarkdown', () => {
  it('accepts empty string', () => {
    const result = normalizedMarkdown('');
    expect(result).toBe('');
  });

  it('accepts valid single-line content', () => {
    const result = normalizedMarkdown('Hello world');
    expect(result).toBe('Hello world');
  });

  it('accepts valid multi-line content with single blank line separators', () => {
    const result = normalizedMarkdown('line1\n\nline2\n\nline3');
    expect(result).toBe('line1\n\nline2\n\nline3');
  });

  it('rejects leading newline', () => {
    expect(() => normalizedMarkdown('\nhello')).toThrow(PresentationContractError);
  });

  it('rejects trailing newline', () => {
    expect(() => normalizedMarkdown('hello\n')).toThrow(PresentationContractError);
  });

  it('rejects trailing whitespace', () => {
    expect(() => normalizedMarkdown('hello   ')).toThrow(PresentationContractError);
  });

  it('rejects trailing whitespace on any line in multi-line content', () => {
    expect(() => normalizedMarkdown('line1   \n\nline2')).toThrow(PresentationContractError);
  });

  it('accepts content with tab indentation (no trailing ws)', () => {
    const result = normalizedMarkdown('line1\n\tindented');
    expect(result).toBe('line1\n\tindented');
  });
});

describe('validateCodeLanguage', () => {
  it('returns empty string for undefined', () => {
    expect(validateCodeLanguage(undefined)).toBe('');
  });

  it('accepts valid language identifiers', () => {
    expect(validateCodeLanguage('typescript')).toBe('typescript');
    expect(validateCodeLanguage('ts')).toBe('ts');
    expect(validateCodeLanguage('C++')).toBe('C++');
    expect(validateCodeLanguage('csharp')).toBe('csharp');
    expect(validateCodeLanguage('bash')).toBe('bash');
  });

  it('rejects language with newline', () => {
    expect(() => validateCodeLanguage('ts\nbad')).toThrow(PresentationContractError);
  });

  it('rejects language with backtick', () => {
    expect(() => validateCodeLanguage('ts`')).toThrow(PresentationContractError);
  });

  it('rejects language with space', () => {
    expect(() => validateCodeLanguage('type script')).toThrow(PresentationContractError);
  });
});

describe('PresentationContractError', () => {
  it('has code PRESENTATION_CONTRACT_VIOLATION', () => {
    const error = new PresentationContractError('test message');
    expect(error.code).toBe('PRESENTATION_CONTRACT_VIOLATION');
    expect(error.message).toContain('test message');
    expect(error.message).toContain('Presentation contract violation');
  });
});
