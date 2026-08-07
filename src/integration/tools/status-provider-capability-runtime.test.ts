/**
 * @module integration/tools/status-provider-capability-runtime.test
 * @description Integration test: providerCapabilities in flowguard_status
 *   includes runtime readiness when probes are run.
 */

import { describe, expect, it } from 'vitest';
import { resolveRuntimeReadiness, wrapForResolution } from '../verification-runtime-resolution.js';
import { reconstructPlannedCandidates } from '../../discovery/verification-planner.js';
import type { ProbeRunner, ProbeRequest, ProbeResult } from '../../verification/toolchain-probe.js';
import type { VerificationCandidate } from '../../state/discovery-schemas.js';
import type {
  ResolvedVerificationCandidate,
  RuntimeStatus,
} from '../verification-runtime-resolution.js';

class FakeProbeRunner implements ProbeRunner {
  constructor(private readonly responses: Record<string, ProbeResult>) {}

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const key =
      request.tool.kind === 'executable_file' ? `file:${request.tool.path}` : request.tool.command;
    return (
      this.responses[key] ?? {
        status: 'unknown',
        reason: 'no fake response',
      }
    );
  }
}

describe('runtime readiness via status projection', () => {
  it('reports ready when vitest candidate probes succeed', async () => {
    const runner = new FakeProbeRunner({
      'node_modules/.bin/vitest --version': {
        status: 'available',
        version: '3.2.7',
      },
    });

    const candidates: VerificationCandidate[] = [
      {
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
      },
    ];

    const results = await resolveRuntimeReadiness(
      reconstructPlannedCandidates(candidates),
      runner,
      '/tmp',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.runtime.status).toBe('ready');
    expect(results[0]!.runtime.requirements).toHaveLength(1);
    expect(results[0]!.runtime.requirements[0]!.status).toBe('available');
    expect(results[0]!.runtime.requirements[0]!.version).toBe('3.2.7');
  });

  it('reports tool_missing when vitest not installed', async () => {
    const runner = new FakeProbeRunner({
      'node_modules/.bin/vitest --version': { status: 'missing' },
    });

    const candidates: VerificationCandidate[] = [
      {
        assertionCapability: 'structured',
        kind: 'test',
        command: 'npx vitest run',
        source: 'detectedStack:testFramework:vitest',
        confidence: 'medium',
        reason: 'vitest detected',
        assertionReport: {
          collection: 'run_specific',
          transport: 'file',
          format: 'vitest_json',
          providerId: 'vitest',
          outputArgumentTemplate: '--out={attemptId}',
          resultPatternTemplate: '.flowguard/{attemptId}.json',
        },
      },
    ];

    const results = await resolveRuntimeReadiness(
      reconstructPlannedCandidates(candidates),
      runner,
      '/tmp',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.runtime.status).toBe('tool_missing');
  });

  it('reports reporter_missing when pytest has no json-report plugin', async () => {
    const runner = new FakeProbeRunner({
      'python --version': { status: 'available' },
      'python -c "import pytest"': { status: 'available' },
      'python -c "import pytest_jsonreport"': { status: 'missing' },
    });

    const candidates: VerificationCandidate[] = [
      {
        assertionCapability: 'structured',
        kind: 'test',
        command: 'python -m pytest',
        source: 'package.json:scripts.test',
        confidence: 'high',
        reason: 'enriched pytest',
        assertionReport: {
          collection: 'run_specific',
          transport: 'file',
          format: 'pytest_json',
          providerId: 'pytest',
          outputArgumentTemplate: '--json-report-file={attemptId}',
          resultPatternTemplate: '.flowguard/{attemptId}.json',
        },
      },
    ];

    const results = await resolveRuntimeReadiness(
      reconstructPlannedCandidates(candidates),
      runner,
      '/tmp',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.runtime.status).toBe('reporter_missing');
  });

  it('JUnit maven wrapper probes java and mvnw via profile requirements', async () => {
    const runner = new FakeProbeRunner({
      'java -version': { status: 'available', version: '21.0.12' },
      'file:./mvnw': { status: 'available' },
    });

    const candidates: VerificationCandidate[] = [
      {
        assertionCapability: 'structured',
        kind: 'build',
        command: './mvnw verify',
        source: 'repo:mvnw',
        confidence: 'high',
        reason: 'Maven wrapper detected',
        assertionReport: {
          collection: 'snapshot_diff',
          transport: 'file',
          format: 'junit_xml',
          providerId: 'junit',
          standardPatterns: ['target/surefire-reports/TEST-*.xml'],
        },
      },
    ];

    const results = await resolveRuntimeReadiness(
      reconstructPlannedCandidates(candidates),
      runner,
      '/tmp',
    );
    expect(results).toHaveLength(1);
    // Profile-level requirements (java + mvnw) both available → ready
    expect(results[0]!.runtime.status).toBe('ready');
    expect(results[0]!.runtime.requirements).toHaveLength(2);
  });

  it('JUnit gradle wrapper reports tool_missing when gradlew missing', async () => {
    const runner = new FakeProbeRunner({
      'java -version': { status: 'available', version: '21.0.12' },
      'file:./gradlew': { status: 'missing' },
    });

    const candidates: VerificationCandidate[] = [
      {
        assertionCapability: 'structured',
        kind: 'test',
        command: './gradlew check',
        source: 'repo:gradlew',
        confidence: 'high',
        reason: 'Gradle wrapper detected',
        assertionReport: {
          collection: 'snapshot_diff',
          transport: 'file',
          format: 'junit_xml',
          providerId: 'junit',
          standardPatterns: ['build/test-results/test/TEST-*.xml'],
        },
      },
    ];

    const results = await resolveRuntimeReadiness(
      reconstructPlannedCandidates(candidates),
      runner,
      '/tmp',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.runtime.status).toBe('tool_missing');
    expect(results[0]!.runtime.requirements[0]!.status).toBe('available');
    expect(results[0]!.runtime.requirements[1]!.status).toBe('missing');
  });
});
