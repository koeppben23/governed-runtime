import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAdmittedSelectors,
  computeAdmittedSelectors,
  findRegistryDrift,
} from '../generate-mutation-registry.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'generate-mutation-registry.mjs');

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempRegistry(registry: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'fg-mutation-registry-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'mutation-profile-registry.json');
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  return path;
}

function emptyRegistry(): {
  version: number;
  profiles: Record<string, { configFile: string; admittedSelectors: string[] }>;
} {
  return {
    version: 1,
    profiles: {
      base: { configFile: 'stryker.conf.json', admittedSelectors: [] },
      'event-core': { configFile: 'stryker.event-core.conf.json', admittedSelectors: [] },
    },
  };
}

const RECORDS = {
  'src/z-last.ts': { config: 'stryker.conf.json' },
  'src/a-first.ts': { config: 'stryker.conf.json' },
  'src/audit/event-core.ts': { config: 'stryker.event-core.conf.json' },
};

describe('generate-mutation-registry', () => {
  it('derives sorted selector lists per profile from the records', () => {
    const expected = computeAdmittedSelectors(emptyRegistry(), RECORDS);

    expect(expected).toEqual({
      base: ['src/a-first.ts', 'src/z-last.ts'],
      'event-core': ['src/audit/event-core.ts'],
    });
  });

  it('fails closed for a record config that maps to no profile', () => {
    expect(() =>
      computeAdmittedSelectors(emptyRegistry(), {
        'src/a.ts': { config: 'stryker.unknown.conf.json' },
      }),
    ).toThrow(/maps to no registry profile/);
  });

  it('fails closed when two profiles share one config file', () => {
    const registry = emptyRegistry();
    registry.profiles['event-core']!.configFile = 'stryker.conf.json';

    expect(() => computeAdmittedSelectors(registry, RECORDS)).toThrow(/share configFile/);
  });

  it('reports a closed registry as drift-free', () => {
    const registry = emptyRegistry();
    const expected = computeAdmittedSelectors(registry, RECORDS);

    expect(findRegistryDrift(applyAdmittedSelectors(registry, expected), expected)).toEqual([]);
  });

  it('reports missing, stale, duplicate, and orphaned project entries', () => {
    const registry = emptyRegistry();
    registry.profiles.base!.admittedSelectors = ['src/z-last.ts', 'src/z-last.ts', 'src/stale.ts'];
    const expected = computeAdmittedSelectors(emptyRegistry(), RECORDS);

    const problems = findRegistryDrift(registry, expected);

    expect(problems).toEqual(
      expect.arrayContaining([
        'base: admittedSelectors contains duplicates',
        'base: missing selector src/a-first.ts',
        'base: stale selector src/stale.ts',
      ]),
    );
  });

  it('does not mutate the input registry when applying the projection', () => {
    const registry = emptyRegistry();
    const expected = computeAdmittedSelectors(registry, RECORDS);

    applyAdmittedSelectors(registry, expected);

    expect(registry.profiles.base!.admittedSelectors).toEqual([]);
    expect(registry.profiles['event-core']!.admittedSelectors).toEqual([]);
  });

  it('passes --check against the committed registry', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('registry projection OK');
  });

  it('fails --check with a missing selector and passes after --write', () => {
    const liveRegistry = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts', 'mutation-profile-registry.json'), 'utf8'),
    );
    const [removedSelector] = liveRegistry.profiles.base.admittedSelectors;
    liveRegistry.profiles.base.admittedSelectors =
      liveRegistry.profiles.base.admittedSelectors.slice(1);
    const path = tempRegistry(liveRegistry);

    const failed = spawnSync(process.execPath, [SCRIPT, '--check', '--registry', path], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(`missing selector ${removedSelector}`);

    const written = spawnSync(process.execPath, [SCRIPT, '--write', '--registry', path], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(written.status).toBe(0);

    const passed = spawnSync(process.execPath, [SCRIPT, '--check', '--registry', path], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(passed.status).toBe(0);

    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.profiles.base.admittedSelectors).toEqual(
      JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'mutation-profile-registry.json'), 'utf8'))
        .profiles.base.admittedSelectors,
    );
  });

  it('rejects a missing mode', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exactly one mode is required');
  });
});
