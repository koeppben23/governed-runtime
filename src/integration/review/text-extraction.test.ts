import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsonFromText, scanTopLevelJsonObjects } from './text-extraction.js';
import { validFindings } from './orchestrator-test-helpers.js';
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
      const text = 'The findings are: {"overallVerdict": "accept"} as shown.';
      const result = extractJsonFromText(text);
      expect(result).toEqual({ overallVerdict: 'accept' });
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
      'text-extraction.ts',
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

describe('scanTopLevelJsonObjects', () => {
  it('recovers a trailing object even when an unbalanced { precedes it in prose', () => {
    // A stray unbalanced brace in prose (e.g. "use {id} placeholder", or a
    // quoted code fragment) must NOT abort the scan of the real trailing object.
    const text =
      'Note: the PUT /tasks/{id} route and an open brace fragment `foo() {` appear here.\n' +
      'My review: {"overallVerdict":"accept","blockingIssues":[]}';
    const objects = scanTopLevelJsonObjects(text);
    const verdicts = objects.filter((o) => typeof o.overallVerdict === 'string');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.overallVerdict).toBe('accept');
  });

  it('collects multiple top-level objects in document order', () => {
    const text = 'a {"x":1} b {"y":2} c {"overallVerdict":"changes_requested"} d';
    const objects = scanTopLevelJsonObjects(text);
    expect(objects).toHaveLength(3);
    expect(objects[2]!.overallVerdict).toBe('changes_requested');
  });

  it('does not treat braces inside string values as structure', () => {
    const text = 'x {"note":"has a } and a { inside","overallVerdict":"accept"} y';
    const objects = scanTopLevelJsonObjects(text);
    expect(objects).toHaveLength(1);
    expect(objects[0]!.overallVerdict).toBe('accept');
  });

  it('returns [] when no balanced object is present', () => {
    expect(scanTopLevelJsonObjects('just prose with a lone { brace')).toEqual([]);
  });

  it('is not poisoned by a stray closing } brace before the real object', () => {
    // A leading unmatched `}` in prose (e.g. quoted code fragment "});") must
    // not corrupt the depth counter for the real object that follows.
    const text =
      'Reviewed snippet: `foo() }` — closing brace only.\n' +
      '{"overallVerdict":"accept","blockingIssues":[]}';
    const objects = scanTopLevelJsonObjects(text);
    const verdicts = objects.filter((o) => typeof o.overallVerdict === 'string');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.overallVerdict).toBe('accept');
  });

  it('handles escaped quotes and braces inside string values', () => {
    // An escaped quote must not prematurely end the string, and a `}` after an
    // escaped quote inside the string must stay treated as string content.
    const obj = {
      note: 'he said \\"done}\\" and left { unbalanced in text',
      overallVerdict: 'accept',
    };
    const json = JSON.stringify(obj);
    const objects = scanTopLevelJsonObjects('prefix ' + json + ' suffix');
    expect(objects).toHaveLength(1);
    expect(objects[0]!.overallVerdict).toBe('accept');
    // Round-trips: the extracted slice parsed back to the same object.
    expect(objects[0]!.note).toBe(obj.note);
  });

  it('matches JSON.parse semantics for a trailing backslash before closing quote', () => {
    // JSON string ending with an escaped backslash: "...\\" — the closing quote
    // is real (the backslash is escaped), so the object closes correctly.
    const json = '{"path":"C:\\\\tmp\\\\","overallVerdict":"accept"}';
    // sanity: this IS valid JSON
    expect(() => JSON.parse(json)).not.toThrow();
    const objects = scanTopLevelJsonObjects('note: ' + json);
    expect(objects).toHaveLength(1);
    expect(objects[0]!.overallVerdict).toBe('accept');
  });

  it('stays linear (O(n)) on pathological open-brace input', () => {
    // 50k unmatched `{` followed by the real object. A quadratic scanner would
    // take seconds here; the linear single-pass scanner must stay well bounded.
    const pathological = '{'.repeat(50000) + ' {"overallVerdict":"accept"}';
    const t0 = Date.now();
    const objects = scanTopLevelJsonObjects(pathological);
    const elapsed = Date.now() - t0;
    expect(objects.some((o) => o.overallVerdict === 'accept')).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it('ignores a lone double-quote in prose between objects', () => {
    // A stray `"` in prose at depth 0 must not start string tracking and swallow
    // the following real object's braces.
    const text = 'He said "review done. {"overallVerdict":"accept","blockingIssues":[]}';
    const objects = scanTopLevelJsonObjects(text);
    const verdicts = objects.filter((o) => typeof o.overallVerdict === 'string');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.overallVerdict).toBe('accept');
  });

  it('handles deeply nested objects with braces inside strings at multiple levels', () => {
    const obj = {
      overallVerdict: 'changes_requested',
      a: { b: { note: 'contains } and { braces', c: [{ d: 'more { } here' }] } },
      blockingIssues: [{ message: 'x { y } z' }],
    };
    const json = JSON.stringify(obj);
    const objects = scanTopLevelJsonObjects('reasoning...\n' + json + '\n...done');
    // Only ONE top-level object, despite many nested braces.
    expect(objects).toHaveLength(1);
    expect(objects[0]!.overallVerdict).toBe('changes_requested');
    // Deep round-trip integrity.
    expect(JSON.stringify(objects[0])).toBe(json);
  });

  it('extracts two separate sibling top-level objects (not nested)', () => {
    const first = JSON.stringify({ overallVerdict: 'accept' });
    const second = JSON.stringify({ overallVerdict: 'changes_requested' });
    const objects = scanTopLevelJsonObjects(`a ${first} b ${second} c`);
    expect(objects).toHaveLength(2);
    expect(objects[0]!.overallVerdict).toBe('accept');
    expect(objects[1]!.overallVerdict).toBe('changes_requested');
  });

  it('recovers the real verdict after an unbalanced object literal that itself contains a verdict', () => {
    // A quoted, UNBALANCED example (missing closing brace) that itself mentions
    // overallVerdict, followed by the real balanced verdict object. The real one
    // must win; the unbalanced example must not be captured as-is.
    const text =
      'Example (do not copy): {"overallVerdict":"accept","nested":{"x":1} ' +
      '... and my real verdict:\n' +
      '{"overallVerdict":"changes_requested","blockingIssues":[{"m":"z"}]}';
    const objects = scanTopLevelJsonObjects(text);
    const verdicts = objects.filter((o) => typeof o.overallVerdict === 'string');
    // Only the balanced trailing object carries a verdict; the unbalanced example
    // never closes so it is not captured, though its inner {"x":1} may be.
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.overallVerdict).toBe('changes_requested');
  });
});
