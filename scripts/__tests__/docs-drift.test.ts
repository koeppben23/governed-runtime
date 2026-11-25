import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertBaselineMetadata,
  collectHashes,
  compareAgainstBaseline,
  derivePages,
  docsBaseUrl,
  extractRelevantSections,
  readPinnedHostVersion,
  run,
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

afterEach(() => vi.restoreAllMocks());

describe('historical V1 docs integrity, never active V2 acceptance', () => {
  it.each([
    { argv: [] },
    { argv: ['--verbose'] },
    { argv: ['--update'] },
    { argv: ['--historical', '--update'] },
  ])('fails explicitly without a valid historical-only invocation $argv', async ({ argv }) => {
    const fetch = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run(argv, fetch)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('NOT_VERIFIED'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs a real historical comparison while leaving V2 coverage NOT_VERIFIED', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValue(MARKDOWN);
    expect(await run(['--historical'], fetch)).toBe(1); // changed bytes cannot pass
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('V2 docs drift: NOT_VERIFIED'),
    );
  });

  it('the workflow is manual, historical and cannot open current SDK-drift issues', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/docs-drift.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^  schedule:/m);
    expect(workflow).toContain('--historical --verbose');
    expect(workflow).toContain('NOT_VERIFIED');
    expect(workflow).not.toContain('issues: write');
    expect(workflow).not.toContain('if: false');
  });
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
    for (const value of ['', '..', '1.19.3/../../dev', 'v 1', '2.2.5', null, 42]) {
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

  it('treats a missing historical page as failure, never a skip', async () => {
    const result = await collectHashes(derivePages('1.19.3'), async (url: string) =>
      url.endsWith('/sdk.mdx') ? null : MARKDOWN,
    );
    expect(result.failures).toEqual(['sdk']);
    expect(result.results.sdk).toBeNull();
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
