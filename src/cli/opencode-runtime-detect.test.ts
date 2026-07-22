/**
 * @module cli/opencode-runtime-detect.test
 * @description Unit tests for best-effort OpenCode runtime evidence collection
 * and structured logging. Detection never gates and never throws.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setAdapterLogger, resetAdapterLogger } from '../logging/adapter-logger.js';
import type { AdapterLogger } from '../logging/adapter-logger.js';

const versionMock = vi.hoisted(() => ({ impl: (): string => '1.4.2\n' }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFileSync: vi.fn(() => Buffer.from(versionMock.impl())),
  };
});

import { detectOpenCodeRuntimeEvidence } from './opencode-runtime-detect.js';

interface LogRecord {
  level: 'info' | 'warn' | 'error';
  service: string;
  message: string;
  extra?: Record<string, unknown>;
}

function makeCapturingLogger(sink: LogRecord[]): AdapterLogger {
  return {
    info: (service, message, extra) => sink.push({ level: 'info', service, message, extra }),
    warn: (service, message, extra) => sink.push({ level: 'warn', service, message, extra }),
    error: (service, message, extra) => sink.push({ level: 'error', service, message, extra }),
  };
}

describe('opencode-runtime-detect', () => {
  let workdir: string;
  let logs: LogRecord[];

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-runtime-detect-'));
    logs = [];
    setAdapterLogger(makeCapturingLogger(logs));
    versionMock.impl = () => '1.4.2\n';
  });

  afterEach(async () => {
    resetAdapterLogger();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  async function writeOpencodeConfig(dir: string, content: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, 'opencode.json'), JSON.stringify(content), 'utf-8');
  }

  describe('HAPPY — CLI runtime', () => {
    it('probes the CLI version and logs a full evidence envelope at info level', async () => {
      await writeOpencodeConfig(workdir, {
        instructions: ['.opencode/flowguard-mandates.md'],
      });
      const evidence = await detectOpenCodeRuntimeEvidence({
        scope: 'repo',
        platform: 'opencode',
        target: workdir,
      });

      expect(evidence.version).toBe('1.4.2');
      expect(evidence.runtimeKind).toBe('cli');
      expect(evidence.runtimeLine).toBeNull();

      const rec = logs.find((l) => l.message === 'opencode runtime evidence');
      expect(rec).toBeDefined();
      expect(rec?.level).toBe('info');
      expect(rec?.extra).toMatchObject({
        version: '1.4.2',
        runtimeKind: 'cli',
        runtimeLine: null,
        installMethod: 'opencode:repo',
      });
      expect(typeof rec?.extra?.os).toBe('string');
      expect(typeof rec?.extra?.installedAt).toBe('string');
    });
  });

  describe('CORNER — Desktop-owned config', () => {
    it('classifies a config with a plugin field as desktop-owned', async () => {
      await writeOpencodeConfig(workdir, {
        plugin: ['some-desktop-plugin'],
        instructions: ['.opencode/flowguard-mandates.md'],
      });
      const evidence = await detectOpenCodeRuntimeEvidence({
        scope: 'global',
        platform: 'opencode',
        target: workdir,
      });
      expect(evidence.runtimeKind).toBe('desktop-owned');
    });

    it('classifies a config with non-FlowGuard instructions as desktop-owned', async () => {
      await writeOpencodeConfig(workdir, {
        instructions: ['some-desktop-owned.md'],
      });
      const evidence = await detectOpenCodeRuntimeEvidence({
        scope: 'global',
        platform: 'opencode',
        target: workdir,
      });
      expect(evidence.runtimeKind).toBe('desktop-owned');
    });
  });

  describe('BAD — version probe fails', () => {
    it('degrades to version=null and warns as undetectable when no config and no version', async () => {
      logs.length = 0;
      setAdapterLogger(makeCapturingLogger(logs));
      versionMock.impl = () => {
        throw new Error('opencode not found');
      };
      // no opencode.json in workdir -> unknown kind (global scope reads target)
      const evidence = await detectOpenCodeRuntimeEvidence({
        scope: 'global',
        platform: 'opencode',
        target: workdir,
      });
      expect(evidence.version).toBeNull();
      expect(evidence.runtimeKind).toBe('unknown');

      const rec = logs.find((l) => l.message.startsWith('opencode runtime evidence'));
      expect(rec?.level).toBe('warn');
      expect(rec?.extra).toMatchObject({ version: null, runtimeKind: 'unknown' });
    });
  });

  describe('EDGE — non-opencode platform', () => {
    it('does not probe a version for non-opencode platforms', async () => {
      const evidence = await detectOpenCodeRuntimeEvidence({
        scope: 'global',
        platform: 'claude-code',
        target: workdir,
      });
      expect(evidence.version).toBeNull();
    });
  });
});
