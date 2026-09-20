import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_VERSION,
  checkCycleLineage,
  edgeKey,
  validateCycleBaseline,
} from '../check-module-cycle-lineage.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'check-module-cycle-lineage.mjs');

interface CycleEdge {
  from: string;
  to: string;
}

function baselineOf(edges: unknown[] = []) {
  return { version: BASELINE_VERSION, edges };
}

function edge(from: string, to: string): CycleEdge {
  return { from, to };
}

describe('validateCycleBaseline', () => {
  it('accepts a well-formed baseline', () => {
    expect(validateCycleBaseline(baselineOf([edge('state', 'shared')]))).toEqual([]);
  });

  it('rejects wrong versions and malformed structures', () => {
    expect(validateCycleBaseline({ ...baselineOf([]), version: 99 }).join('; ')).toContain(
      'version',
    );
    expect(validateCycleBaseline(null).join('; ')).toContain('not an object');
    expect(
      validateCycleBaseline({ version: BASELINE_VERSION, edges: 'nope' }).join('; '),
    ).toContain('not an array');
    expect(validateCycleBaseline(baselineOf([{ from: 'a' }])).join('; ')).toContain('malformed');
  });

  it('rejects duplicate edges and self edges', () => {
    expect(
      validateCycleBaseline(baselineOf([edge('state', 'shared'), edge('state', 'shared')])).join(
        '; ',
      ),
    ).toContain('duplicate');
    expect(validateCycleBaseline(baselineOf([edge('state', 'state')])).join('; ')).toContain(
      'self edge',
    );
  });

  it('rejects unknown fields instead of ignoring them', () => {
    const unknownTopLevel = validateCycleBaseline({
      ...baselineOf([]),
      updatedAt: '2026-09-19',
    });
    expect(unknownTopLevel.join('; ')).toContain("unknown field 'updatedAt'");

    const unknownEdgeField = validateCycleBaseline(
      baselineOf([{ from: 'state', to: 'shared', note: 'legacy' }]),
    );
    expect(unknownEdgeField.join('; ')).toContain("unknown field 'note' in baseline edge");
  });
});

describe('checkCycleLineage', () => {
  it('accepts an unchanged baseline', () => {
    const base = baselineOf([edge('state', 'shared'), edge('shared', 'state')]);
    const head = baselineOf([edge('state', 'shared'), edge('shared', 'state')]);
    expect(checkCycleLineage(base, head)).toEqual([]);
  });

  it('accepts a shrunk baseline and is order-insensitive', () => {
    const base = baselineOf([edge('state', 'shared'), edge('shared', 'state')]);
    const head = baselineOf([edge('shared', 'state')]);
    expect(checkCycleLineage(base, head)).toEqual([]);
  });

  it('fails the PR bypass: code plus baseline extended together', () => {
    const base = baselineOf([edge('state', 'shared')]);
    const head = baselineOf([edge('state', 'shared'), edge('state', 'discovery')]);
    expect(checkCycleLineage(base, head)).toEqual([
      { kind: 'new-cycle-edge', from: 'state', to: 'discovery' },
    ]);
  });

  it('treats a missing base baseline as empty (bootstrap commit)', () => {
    expect(checkCycleLineage({}, baselineOf([edge('state', 'shared')])).map((v) => v.kind)).toEqual(
      ['new-cycle-edge'],
    );
  });

  it('uses a direction-preserving edge identity', () => {
    expect(edgeKey('a', 'b')).toBe(edgeKey('a', 'b'));
    expect(edgeKey('a', 'b')).not.toBe(edgeKey('b', 'a'));
    expect(edgeKey('a', 'b')).not.toBe('ab');
  });
});

describe('check-module-cycle-lineage CLI', () => {
  it('validates the committed baseline without arguments', () => {
    const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('passes against HEAD (baseline equality or bootstrap)', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--against', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails closed on an unresolvable base commit', () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--against', '0000000000000000000000000000000000000000'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read base commit');
  });

  it('rejects unsupported arguments', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--update'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported argument');
  });
});
