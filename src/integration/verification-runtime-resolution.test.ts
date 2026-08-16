/**
 * @module integration/verification-runtime-resolution.test
 * @description Tests for runtime readiness resolution.
 */

import { describe, expect, it } from 'vitest';
import { resolveRuntimeReadiness, wrapForResolution } from './verification-runtime-resolution.js';
import type {
  ProbeRunner,
  ProbeRequest,
  ProbeResult,
  ProbeSpec,
} from '../verification/toolchain-probe.js';
import type { VerificationCandidate } from '../state/discovery-schemas.js';

class FakeProbeRunner implements ProbeRunner {
  constructor(private readonly responses: Record<string, ProbeResult>) {}

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const key =
      request.tool.kind === 'executable_file' ? `file:${request.tool.path}` : request.tool.command;
    return this.responses[key] ?? { status: 'unknown', reason: 'no fake response' };
  }
}

function sc(overrides: Partial<VerificationCandidate> = {}): VerificationCandidate {
  return {
    assertionCapability: 'structured',
    kind: 'test',
    command: 'npm run test --',
    source: 'package.json:scripts.test',
    confidence: 'high',
    reason: 'enriched vitest',
    assertionReport: {
      collection: 'run_specific',
      transport: 'file',
      format: 'vitest_json',
      providerId: 'vitest',
      outputArgumentTemplate: '--out={attemptId}',
      resultPatternTemplate: '.flowguard/{attemptId}.json',
    },
    ...overrides,
  };
}

function unsupported(): VerificationCandidate {
  return {
    assertionCapability: 'unsupported',
    kind: 'lint',
    command: 'eslint .',
    source: 'detectedStack:qualityTool:eslint',
    confidence: 'medium',
    reason: 'eslint detected',
  };
}

describe('resolveRuntimeReadiness', () => {
  it('ready when all probes succeed', async () => {
    const runner = new FakeProbeRunner({
      'node_modules/.bin/vitest --version': { status: 'available', version: '3.2.7' },
    });
    const results = await resolveRuntimeReadiness(wrapForResolution([sc()]), runner, '/tmp');
    expect(results[0]!.runtime.status).toBe('ready');
  });

  it('tool_missing when tool probe returns missing', async () => {
    const runner = new FakeProbeRunner({
      'node_modules/.bin/vitest --version': { status: 'missing' },
    });
    const results = await resolveRuntimeReadiness(wrapForResolution([sc()]), runner, '/tmp');
    expect(results[0]!.runtime.status).toBe('tool_missing');
  });

  it('reporter_missing for pytest without json-report', async () => {
    const runner = new FakeProbeRunner({
      'python --version': { status: 'available' },
      'python -c "import pytest"': { status: 'available' },
      'python -c "import pytest_jsonreport"': { status: 'missing' },
    });
    const planned = wrapForResolution([
      sc({
        assertionReport: {
          collection: 'run_specific',
          transport: 'file',
          format: 'pytest_json',
          providerId: 'pytest',
          outputArgumentTemplate: '--json-report-file={attemptId}',
          resultPatternTemplate: '.flowguard/{attemptId}.json',
        },
      }),
    ]);
    const results = await resolveRuntimeReadiness(planned, runner, '/tmp');
    expect(results[0]!.runtime.status).toBe('reporter_missing');
  });

  it('unavailable for unsupported candidate', async () => {
    const runner = new FakeProbeRunner({});
    const results = await resolveRuntimeReadiness(
      wrapForResolution([unsupported()]),
      runner,
      '/tmp',
    );
    expect(results[0]!.runtime.status).toBe('unavailable');
  });

  it('unknown when probe returns unknown', async () => {
    const runner = new FakeProbeRunner({
      'node_modules/.bin/vitest --version': { status: 'unknown', reason: 'timeout' },
    });
    const results = await resolveRuntimeReadiness(wrapForResolution([sc()]), runner, '/tmp');
    expect(results[0]!.runtime.status).toBe('unknown');
  });
});
