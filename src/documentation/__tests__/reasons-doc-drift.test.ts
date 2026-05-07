/**
 * @module documentation/__tests__/reasons-doc-drift
 * @description Bidirectional drift guard for troubleshooting reason-code docs.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultReasonRegistry } from '../../config/reasons.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

function readTroubleshooting(): string {
  return readFileSync(join(REPO_ROOT, 'docs/troubleshooting.md'), 'utf-8').replace(/\r\n/g, '\n');
}

function registeredCodes(): string[] {
  return defaultReasonRegistry.codes().sort();
}

function extractErrorCodeSection(content: string): string {
  const match = content.match(/## Error Codes[\s\S]*?## Debug Mode/);
  expect(
    match,
    'docs/troubleshooting.md must contain an Error Codes section before Debug Mode',
  ).toBeTruthy();
  return match![0];
}

function extractCompleteIndexCodes(content: string): string[] {
  const match = content.match(/## Complete Registered Code Index[\s\S]*?```text\n([\s\S]*?)\n```/);
  expect(
    match,
    'docs/troubleshooting.md must contain Complete Registered Code Index text block',
  ).toBeTruthy();
  return match![1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function extractBacktickedReasonCodes(content: string): string[] {
  return Array.from(content.matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm), (match) => match[1]).sort();
}

describe('documentation/reasons-doc-drift', () => {
  describe('HAPPY — complete index mirrors registry', () => {
    it('Complete Registered Code Index matches defaultReasonRegistry.codes()', () => {
      expect(extractCompleteIndexCodes(readTroubleshooting())).toEqual(registeredCodes());
    });
  });

  describe('BAD — documented reason codes cannot be phantom codes', () => {
    it('all backticked reason-code-looking tokens in Error Codes are registered', () => {
      const registered = new Set(registeredCodes());
      const sectionCodes = extractBacktickedReasonCodes(
        extractErrorCodeSection(readTroubleshooting()),
      );
      const phantomCodes = sectionCodes.filter((code) => !registered.has(code));

      expect(phantomCodes).toEqual([]);
    });
  });

  describe('CORNER — registry metadata is intact for indexed codes', () => {
    it('every indexed code resolves to a registered reason entry', () => {
      for (const code of extractCompleteIndexCodes(readTroubleshooting())) {
        expect(
          defaultReasonRegistry.get(code),
          `${code} must resolve in defaultReasonRegistry`,
        ).toBeTruthy();
      }
    });
  });

  describe('EDGE — index has no duplicate entries', () => {
    it('Complete Registered Code Index contains each code once', () => {
      const codes = extractCompleteIndexCodes(readTroubleshooting());
      expect(new Set(codes).size).toBe(codes.length);
    });
  });
});
