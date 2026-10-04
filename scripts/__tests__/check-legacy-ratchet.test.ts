import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'check-legacy-ratchet.mjs');

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flowguard-legacy-ratchet-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeBaseline(name: string, legacySelectors: readonly unknown[]): string {
  const path = join(temporaryDirectory(), name);
  writeFileSync(path, JSON.stringify({ version: 1, legacySelectors }), 'utf8');
  return path;
}

function writeRaw(name: string, content: string): string {
  const path = join(temporaryDirectory(), name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function runVerifier(args: readonly string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

const ENTRY_A = { profile: 'base', mutateSelector: 'src/a.ts' };
const ENTRY_B = { profile: 'base', mutateSelector: 'src/b.ts' };
const ENTRY_C = { profile: 'human-projection', mutateSelector: 'src/c.ts:1-2' };

describe('check-legacy-ratchet', () => {
  it('accepts an unchanged baseline', () => {
    const head = writeBaseline('head.json', [ENTRY_A, ENTRY_B]);
    const base = writeBaseline('base.json', [ENTRY_A, ENTRY_B]);

    const result = runVerifier(['--head-file', head, '--base-file', base]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('head=2 base=2 removed=0 OK');
  });

  it('accepts a shrunk baseline', () => {
    const head = writeBaseline('head.json', [ENTRY_A]);
    const base = writeBaseline('base.json', [ENTRY_A, ENTRY_B]);

    const result = runVerifier(['--head-file', head, '--base-file', base]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('head=1 base=2 removed=1 OK');
  });

  it('rejects a grown baseline and names the additions', () => {
    const head = writeBaseline('head.json', [ENTRY_A, ENTRY_B, ENTRY_C]);
    const base = writeBaseline('base.json', [ENTRY_A, ENTRY_B]);

    const result = runVerifier(['--head-file', head, '--base-file', base]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('legacy baseline grew by 1 entry');
    expect(result.stderr).toContain('human-projection: src/c.ts:1-2');
  });

  it('accepts the first introduction when the base has no baseline', () => {
    const head = writeBaseline('head.json', [ENTRY_A]);
    const missingBase = join(temporaryDirectory(), 'missing.json');

    const result = runVerifier(['--head-file', head, '--base-file', missingBase]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('introduction OK');
  });

  it('rejects malformed baseline JSON', () => {
    const head = writeRaw('head.json', '{ not json');
    const base = writeBaseline('base.json', [ENTRY_A]);

    const result = runVerifier(['--head-file', head, '--base-file', base]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot parse');
  });

  it('rejects duplicate baseline entries', () => {
    const head = writeBaseline('head.json', [ENTRY_A, ENTRY_A]);
    const base = writeBaseline('base.json', [ENTRY_A]);

    const result = runVerifier(['--head-file', head, '--base-file', base]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate entries');
  });

  it('rejects unsupported arguments', () => {
    const result = runVerifier(['--head-file', 'x', '--bogus']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported argument '--bogus'");
  });
});
