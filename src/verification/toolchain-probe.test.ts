/**
 * @module verification/toolchain-probe.test
 * @description Tests for toolchain probing with fake runner.
 */

import { describe, expect, it } from 'vitest';
import type { ProbeRunner, ProbeRequest, ProbeResult, ProbeSpec } from './toolchain-probe.js';
import { ProcessProbeRunner } from './toolchain-probe.js';

class FakeProbeRunner implements ProbeRunner {
  private responses = new Map<string, ProbeResult>();

  constructor(responses: ReadonlyMap<string, ProbeResult> | Record<string, ProbeResult>) {
    const map = responses instanceof Map ? responses : new Map(Object.entries(responses));
    this.responses = map;
  }

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const key =
      request.tool.kind === 'executable_file' ? `file:${request.tool.path}` : request.tool.command;
    const found = this.responses.get(key);
    if (found) return found;
    return { status: 'unknown', reason: `no fake response for: ${key}` };
  }
}

describe('FakeProbeRunner', () => {
  it('returns available with version', async () => {
    const runner = new FakeProbeRunner({
      'python --version': { status: 'available', version: '3.12.1' },
    });

    const result = await runner.probe({
      tool: { kind: 'exec', id: 'python', role: 'runtime', command: 'python --version' },
      cwd: '/tmp',
    });

    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.version).toBe('3.12.1');
    }
  });

  it('returns missing', async () => {
    const runner = new FakeProbeRunner({
      'go version': { status: 'missing' },
    });

    const result = await runner.probe({
      tool: { kind: 'exec', id: 'go', role: 'tool', command: 'go version' },
      cwd: '/tmp',
    });

    expect(result.status).toBe('missing');
  });

  it('returns unknown for unexpected command', async () => {
    const runner = new FakeProbeRunner({});

    const result = await runner.probe({
      tool: { kind: 'exec', id: 'unknown', role: 'tool', command: 'unknown-cmd --version' },
      cwd: '/tmp',
    });

    expect(result.status).toBe('unknown');
  });

  it('returns unknown for known command marked unknown', async () => {
    const runner = new FakeProbeRunner({
      pytest: { status: 'unknown', reason: 'probe timed out' },
    });

    const result = await runner.probe({
      tool: { kind: 'exec', id: 'pytest', role: 'tool', command: 'pytest' },
      cwd: '/tmp',
    });

    expect(result.status).toBe('unknown');
  });
});

describe('ProcessProbeRunner', () => {
  it('available for node --version', async () => {
    const runner = new ProcessProbeRunner();
    const result = await runner.probe({
      tool: { kind: 'exec', id: 'node', role: 'runtime', command: 'node --version' },
      cwd: '/tmp',
    });

    expect(result.status).toBe('available');
  });

  it('missing for nonexistent binary', async () => {
    const runner = new ProcessProbeRunner();
    const result = await runner.probe({
      tool: { kind: 'exec', id: 'nonexistent', role: 'tool', command: 'nonexistent-binary-xyz123' },
      cwd: '/tmp',
    });

    expect(result.status).toBe('missing');
  });

  it('caches results for same probe', async () => {
    const runner = new ProcessProbeRunner();
    const first = await runner.probe({
      tool: { kind: 'exec', id: 'node', role: 'runtime', command: 'node --version' },
      cwd: '/tmp',
    });
    const second = await runner.probe({
      tool: { kind: 'exec', id: 'node', role: 'runtime', command: 'node --version' },
      cwd: '/tmp',
    });

    expect(first).toEqual(second);
    expect(first.status).toBe('available');
  });
});
