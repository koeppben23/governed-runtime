import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCases } from '../load-cases.js';
import { RunnerConfigSchema, EvalCaseSchema } from '../schema.js';
import { snapshotWorkspace } from '../runners/process-runner.js';

describe('agent instruction forensic regressions', () => {
  it('rejects duplicate case IDs before report paths can collide', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-duplicate-id-'));
    try {
      const yaml = `id: duplicate-case\ndescription: duplicate\ninstructionSurface: repository_contributor\nmode: output-only\ntask: test\nassertions:\n  - type: exit_code\n    value: 0\n    description: exit\n`;
      writeFileSync(join(dir, 'a.yaml'), yaml);
      writeFileSync(join(dir, 'b.yaml'), yaml);
      expect(() => loadCases(dir)).toThrow('Duplicate eval case ID: duplicate-case');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid regex assertions during schema validation', () => {
    const parsed = EvalCaseSchema.safeParse({
      id: 'invalid-regex',
      description: 'invalid regex',
      instructionSurface: 'repository_contributor',
      mode: 'output-only',
      task: 'test',
      assertions: [
        {
          type: 'output_matches',
          pattern: '[',
          flags: 'g',
          description: 'invalid',
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('requires live runners to bind an explicit host', () => {
    const parsed = RunnerConfigSchema.safeParse({
      name: 'live',
      command: 'agent',
      provider: 'provider',
      model: 'model',
      modelVersion: '1',
      runnerVersion: '1',
      runnerKind: 'live-host',
      promptTransport: 'stdin',
      args: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects secret-like static environment keys', () => {
    const parsed = RunnerConfigSchema.safeParse({
      name: 'runner',
      command: 'agent',
      provider: 'provider',
      model: 'model',
      modelVersion: '1',
      runnerVersion: '1',
      promptTransport: 'stdin',
      args: [],
      staticEnv: { PROVIDER_API_KEY: 'not-allowed-here' },
    });
    expect(parsed.success).toBe(false);
  });

  it('does not follow file symlinks while snapshotting a workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-file-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'eval-file-outside-'));
    try {
      mkdirSync(join(root, 'data'));
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
      try {
        symlinkSync(join(outside, 'secret.txt'), join(root, 'data', 'linked.txt'), 'file');
      } catch {
        return;
      }
      const snapshot = snapshotWorkspace(root);
      expect(snapshot.entries.has('data/linked.txt')).toBe(false);
      expect(snapshot.contents.has('data/linked.txt')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
