import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsonFromText } from './review-text-extraction.js';
import { validFindings } from './review-orchestrator-test-helpers.js';
describe('extractJsonFromText', () => {
  // ─── HAPPY ──────────────────────────────────────────────────────────────────

  describe('HAPPY — valid JSON extraction', () => {
    it('parses pure JSON object', () => {
      const result = extractJsonFromText('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    it('parses JSON with whitespace around it', () => {
      const result = extractJsonFromText('  \n {"key": "value"} \n ');
      expect(result).toEqual({ key: 'value' });
    });

    it('extracts from markdown fence (```json)', () => {
      const text = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ key: 'value' });
    });

    it('extracts from markdown fence (``` without json tag)', () => {
      const text = '```\n{"key": "value"}\n```';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ key: 'value' });
    });

    it('extracts outermost braces from prose', () => {
      const text = 'The findings are: {"overallVerdict": "approve"} as shown.';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ overallVerdict: 'approve' });
    });
  });

  // ─── BAD ────────────────────────────────────────────────────────────────────

  describe('BAD — non-extractable content', () => {
    it('returns null for empty string', () => {
      expect(extractJsonFromText('')).toBeNull();
    });

    it('returns null for whitespace only', () => {
      expect(extractJsonFromText('   \n\t  ')).toBeNull();
    });

    it('returns null for plain text without JSON', () => {
      expect(extractJsonFromText('I cannot review this content.')).toBeNull();
    });

    it('returns null for JSON array (not object)', () => {
      expect(extractJsonFromText('[1, 2, 3]')).toBeNull();
    });

    it('returns null for invalid JSON in braces', () => {
      expect(extractJsonFromText('{not valid json}')).toBeNull();
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────────

  describe('CORNER — complex structures', () => {
    it('handles nested objects', () => {
      const nested = { a: { b: { c: 1 } }, d: [1, 2] };
      const result = extractJsonFromText(JSON.stringify(nested));
      expect(result).toEqual(nested);
    });

    it('handles complex review findings JSON', () => {
      const findings = validFindings();
      const result = extractJsonFromText(JSON.stringify(findings));
      expect(result).toEqual(findings);
    });

    it('handles JSON with escaped characters', () => {
      const text = '{"msg": "hello \\"world\\"", "path": "C:\\\\Users"}';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ msg: 'hello "world"', path: 'C:\\Users' });
    });

    it('prefers direct parse over fence extraction', () => {
      // If the entire text is valid JSON, returns it directly
      const json = '{"strategy": "direct"}';
      const result = extractJsonFromText(json);
      expect(result).toEqual({ strategy: 'direct' });
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────────────────────

  describe('EDGE — boundary cases', () => {
    it('handles multiple JSON objects (extracts first outermost)', () => {
      const text = 'First: {"a": 1} Second: {"b": 2}';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ a: 1 });
    });

    it('handles empty object', () => {
      expect(extractJsonFromText('{}')).toEqual({});
    });

    it('handles JSON with unicode', () => {
      const result = extractJsonFromText('{"name": "日本語テスト"}');
      expect(result).toEqual({ name: '日本語テスト' });
    });

    it('handles malformed fence but valid brace extraction', () => {
      const text = '```json\nnot valid\n```\n{"fallback": true}';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ fallback: true });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// invokeReviewer — Dual-Path Integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('extractJsonFromText JSDoc', () => {
  it('SMOKE — JSDoc references info.structured_output (canonical docs field)', async () => {
    const extractionPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'review-text-extraction.ts',
    );
    const source = await fs.readFile(extractionPath, 'utf-8');

    // The extractJsonFromText JSDoc should reference the canonical docs field name
    // "info.structured_output", not the server alias "info.structured".
    const jsdocMatch = source.match(
      /\/\*\*[\s\S]*?Extract JSON from unstructured text response[\s\S]*?\*\//,
    );
    expect(jsdocMatch).not.toBeNull();
    const jsdoc = jsdocMatch![0];
    expect(jsdoc).toContain('info.structured_output');
  });
});