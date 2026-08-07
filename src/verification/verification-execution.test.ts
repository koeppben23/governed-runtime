import { describe, expect, it } from 'vitest';
import {
  prepareVerificationExecution,
  type PreparedVerificationExecution,
} from './verification-execution.js';
import type { VerificationCandidate } from '../state/discovery-schemas.js';

function makeCandidate(overrides?: Partial<VerificationCandidate>): VerificationCandidate {
  return {
    assertionCapability: 'unsupported' as const,
    kind: 'test',
    command: 'npm test',
    source: 'package.json',
    confidence: 'high',
    reason: 'test',
    ...overrides,
  } as VerificationCandidate;
}

describe('prepareVerificationExecution', () => {
  it('returns unsupported assertion capability for unsupported candidates', async () => {
    const prepared = await prepareVerificationExecution(makeCandidate(), '/tmp');
    expect(prepared.attemptId).toBeDefined();
    expect(prepared.command).toBe('npm test');
    expect(prepared.assertion.capability).toBe('unsupported');
  });

  it('rejects provider-format mismatch', async () => {
    const candidate = makeCandidate({
      assertionCapability: 'structured' as const,
      assertionReport: {
        collection: 'run_specific' as const,
        transport: 'file' as const,
        format: 'junit_xml' as const,
        providerId: 'vitest' as const,
        outputArgumentTemplate: '--out={attemptId}',
        resultPatternTemplate: '{attemptId}.xml',
      },
    } as VerificationCandidate);
    await expect(prepareVerificationExecution(candidate, '/tmp')).rejects.toThrow(
      'does not support report format',
    );
  });

  it('builds run_specific command with attemptId substitution', async () => {
    const candidate = makeCandidate({
      assertionCapability: 'structured' as const,
      assertionReport: {
        collection: 'run_specific' as const,
        transport: 'file' as const,
        format: 'vitest_json' as const,
        providerId: 'vitest' as const,
        outputArgumentTemplate:
          '--reporter=json --outputFile=.flowguard/reports/{attemptId}/vitest.json',
        resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.json',
      },
    } as VerificationCandidate);
    const prepared = await prepareVerificationExecution(candidate, '/tmp', 'test-id');
    expect(prepared.command).toContain('--reporter=json');
    expect(prepared.command).toContain('test-id');
    expect(prepared.command).not.toContain('{attemptId}');
    expect(prepared.assertion.capability).toBe('structured');
    if (prepared.assertion.capability === 'structured') {
      expect(prepared.assertion.report.kind).toBe('run_specific');
      expect((prepared.assertion.report as { resultPattern: string }).resultPattern).toContain(
        'test-id',
      );
    }
  });

  it('stdout collection keeps command unchanged', async () => {
    const candidate = makeCandidate({
      assertionCapability: 'structured' as const,
      assertionReport: {
        collection: 'stdout' as const,
        transport: 'stdout' as const,
        format: 'go_test_json' as const,
        providerId: 'go_test' as const,
      },
    } as VerificationCandidate);
    const prepared = await prepareVerificationExecution(candidate, '/tmp');
    expect(prepared.command).toBe('npm test');
    expect(prepared.assertion.capability).toBe('structured');
  });

  it('generates a UUID attemptId when not provided', async () => {
    const prepared = await prepareVerificationExecution(makeCandidate(), '/tmp');
    expect(prepared.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
