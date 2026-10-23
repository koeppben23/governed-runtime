import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBaselineMetadata,
  buildBaseline,
  compareAgainstBaseline,
  derivePages,
  docsBaseUrl,
  extractRelevantSections,
  readPinnedHostVersion,
} from '../docs-drift.mjs';

const MARKDOWN = [
  '---',
  'title: Fixture',
  '---',
  '',
  '## Section',
  '',
  '| A | B |',
  '| - | - |',
  '',
  '```json',
  '{ "a": 1 }',
  '```',
  '',
  'Prose is ignored.',
].join('\n');

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    generated: '2026-01-01T00:00:00.000Z',
    version: '1',
    opencodeVersion: '1.19.3',
    hashes: Object.fromEntries(
      derivePages('1.19.3').map((page: { key: string }) => [
        page.key,
        { hash: `hash-${page.key}`, sections: 1 },
      ]),
    ),
    ...overrides,
  };
}

describe('scripts/docs-drift', () => {
  it('pins every docs URL to the exact host tag and never to a moving branch', () => {
    expect(docsBaseUrl('1.19.3')).toBe(
      'https://raw.githubusercontent.com/anomalyco/opencode/v1.19.3/packages/web/src/content/docs',
    );
    expect(docsBaseUrl('1.19.3')).not.toContain('/dev/');
    for (const page of derivePages('1.19.3')) {
      expect(page.url).toContain('/v1.19.3/packages/web/src/content/docs/');
    }
    expect(derivePages('1.19.3')).toHaveLength(8);
  });

  it('rejects URL-unsafe versions instead of interpolating them', () => {
    for (const value of ['', '..', '1.19.3/../../dev', 'v 1', null, 42]) {
      expect(() => docsBaseUrl(value)).toThrow(/Invalid OpenCode version/);
    }
  });

  it('extracts only structural sections', () => {
    expect(extractRelevantSections(MARKDOWN).sections).toEqual([
      '```json\n{ "a": 1 }\n```',
      '| A | B |',
      '| - | - |',
      '## Section',
    ]);
  });

  it('requires a baseline for the currently pinned host version', () => {
    expect(() => assertBaselineMetadata(baseline(), '1.19.3')).not.toThrow();
    expect(() => assertBaselineMetadata(baseline(), '1.19.4')).toThrow(/pinned to OpenCode 1.19.3/);
    expect(() =>
      assertBaselineMetadata(baseline({ opencodeVersion: undefined }), '1.19.3'),
    ).toThrow(/pinned to OpenCode undefined/);
    expect(() => assertBaselineMetadata(baseline({ version: '2' }), '1.19.3')).toThrow(
      /Unsupported docs baseline schema/,
    );
    expect(() => assertBaselineMetadata(baseline({ hashes: {} }), '1.19.3')).toThrow(
      /page set is stale/,
    );
    const invalidEntry = baseline();
    invalidEntry.hashes.sdk = { hash: '', sections: 1 };
    expect(() => assertBaselineMetadata(invalidEntry, '1.19.3')).toThrow(/entry "sdk" is invalid/);
  });

  it('detects changed pages and ignores matching ones', () => {
    const pages = derivePages('1.19.3');
    const results = Object.fromEntries(
      pages.map((page: { key: string }) => [
        page.key,
        { hash: page.key === 'plugins' ? 'changed' : `hash-${page.key}`, sections: 1 },
      ]),
    );
    expect(compareAgainstBaseline(pages, results, baseline())).toEqual(['plugins']);
  });

  it('refuses to persist a partial baseline', () => {
    const pages = derivePages('1.19.3');
    const results = Object.fromEntries(
      pages.map((page: { key: string }) => [
        page.key,
        page.key === 'sdk' ? null : { hash: `hash-${page.key}`, sections: 1 },
      ]),
    );
    expect(() =>
      buildBaseline({
        pages,
        results,
        pinnedVersion: '1.19.3',
        generatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow(/Refusing a partial docs baseline.*sdk/);
  });

  it('builds a complete pinned baseline', () => {
    const pages = derivePages('1.19.3');
    const results = Object.fromEntries(
      pages.map((page: { key: string }) => [page.key, { hash: `hash-${page.key}`, sections: 2 }]),
    );
    expect(
      buildBaseline({
        pages,
        results,
        pinnedVersion: '1.19.3',
        generatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({
      version: '1',
      opencodeVersion: '1.19.3',
      hashes: Object.fromEntries(
        pages.map((page: { key: string }) => [page.key, { hash: `hash-${page.key}`, sections: 2 }]),
      ),
    });
  });

  it('keeps the docs baseline pinned to the host baseline', () => {
    const readJson = (name: string) =>
      JSON.parse(
        readFileSync(new URL(`../../.sdk-baselines/opencode/${name}`, import.meta.url), 'utf8'),
      );
    const hostVersion = readJson('host-version.json').version;
    expect(readPinnedHostVersion()).toBe(hostVersion);
    expect(readJson('docs-hashes.json').opencodeVersion).toBe(hostVersion);
  });

  it('rejects malformed pinned host versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-docs-drift-'));
    try {
      const invalid = join(dir, 'host-version.json');
      writeFileSync(invalid, JSON.stringify({ version: '1.19.3/../../dev' }), 'utf8');
      expect(() => readPinnedHostVersion(invalid)).toThrow(/Invalid pinned OpenCode host version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
