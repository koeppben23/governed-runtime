import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectAssertionReports } from './assertion-report-collector.js';
import type {
  PreparedVerificationExecution,
  PreparedAssertionReportRunSpecific,
  PreparedAssertionReportStdout,
} from './verification-execution.js';
import type { ExecutionEvidence } from './executor.js';

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeEvidence(stdout: string): ExecutionEvidence {
  return {
    kind: 'test',
    command: 'test',
    exitCode: 0,
    passed: true,
    executionMs: 1,
    outputDigest: sha256(stdout),
    stdout,
    stderr: '',
    timedOut: false,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('collectAssertionReports', () => {
  describe('run_specific', () => {
    it('collects a single report', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'fc-'));
      const reportDir = join(tmpDir, '.flowguard', 'reports', 'my-run');
      await mkdir(reportDir, { recursive: true });
      const relPath = join('.flowguard', 'reports', 'my-run', 'vitest.json');
      await writeFile(join(tmpDir, relPath), '{"ok":true}');

      const prepared: PreparedVerificationExecution = {
        attemptId: 'my-run',
        kind: 'test',
        command: 'npx vitest run',
        assertion: {
          capability: 'structured',
          report: {
            kind: 'run_specific',
            spec: {
              collection: 'run_specific' as const,
              transport: 'file' as const,
              format: 'vitest_json' as const,
              providerId: 'vitest' as const,
              outputArgumentTemplate: '--out={attemptId}',
              resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.json',
            },
            resultPattern: '.flowguard/reports/my-run/vitest.json',
          } satisfies PreparedAssertionReportRunSpecific,
        },
      };
      const result = await collectAssertionReports(prepared, makeEvidence(''), tmpDir);
      expect(result.status).toBe('collected');
      if (result.status === 'collected' && result.report.transport === 'file') {
        expect(result.report.reports).toHaveLength(1);
        expect(result.report.reports[0]!.path).toBe(relPath);
      }
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('blocks when no report found', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'fc-'));
      await mkdir(tmpDir, { recursive: true });
      const prepared: PreparedVerificationExecution = {
        attemptId: 'nope',
        kind: 'test',
        command: 'run',
        assertion: {
          capability: 'structured',
          report: {
            kind: 'run_specific',
            spec: {
              collection: 'run_specific' as const,
              transport: 'file' as const,
              format: 'vitest_json' as const,
              providerId: 'vitest' as const,
              outputArgumentTemplate: '--out={attemptId}',
              resultPatternTemplate: '.flowguard/{attemptId}.json',
            },
            resultPattern: '.flowguard/nope.json',
          } satisfies PreparedAssertionReportRunSpecific,
        },
      };
      const result = await collectAssertionReports(prepared, makeEvidence(''), tmpDir);
      expect(result.status).toBe('blocked');
      if (result.status === 'blocked') {
        expect(result.reasonCode).toBe('report_missing');
      }
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('rejects report outside cwd', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'fc-'));
      const otherDir = await mkdtemp(join(tmpdir(), 'other-'));
      const reportPath = join(otherDir, 'report.json');
      await writeFile(reportPath, '{}');

      const prepared: PreparedVerificationExecution = {
        attemptId: 'x',
        kind: 'test',
        command: 'run',
        assertion: {
          capability: 'structured',
          report: {
            kind: 'run_specific',
            spec: {
              collection: 'run_specific' as const,
              transport: 'file' as const,
              format: 'vitest_json' as const,
              providerId: 'vitest' as const,
              outputArgumentTemplate: '--out={attemptId}',
              resultPatternTemplate: '../../report.json',
            },
            resultPattern: '../../report.json',
          } satisfies PreparedAssertionReportRunSpecific,
        },
      };
      // Pattern points outside cwd — globFiles catches it before reading
      // because the base dir resolves outside cwd
      const result = await collectAssertionReports(prepared, makeEvidence(''), tmpDir);
      expect(result.status).toBe('blocked');
      await rm(tmpDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
    });
  });

  describe('stdout', () => {
    it('collects valid stdout', async () => {
      const prepared: PreparedVerificationExecution = {
        attemptId: 'run-1',
        kind: 'test',
        command: 'go test -json ./...',
        assertion: {
          capability: 'structured',
          report: {
            kind: 'stdout',
            spec: {
              collection: 'stdout' as const,
              transport: 'stdout' as const,
              format: 'go_test_json' as const,
              providerId: 'go_test' as const,
            },
          } satisfies PreparedAssertionReportStdout,
        },
      };
      const evidence = makeEvidence('{"Action":"pass","Test":"TestX"}');
      const result = await collectAssertionReports(prepared, evidence, '/tmp');
      expect(result.status).toBe('collected');
      if (result.status === 'collected' && result.report.transport === 'stdout') {
        expect(result.report.content).toBe(evidence.stdout);
      }
    });

    it('passes empty stdout through', async () => {
      const prepared: PreparedVerificationExecution = {
        attemptId: 'run-1',
        kind: 'test',
        command: 'go test -json ./...',
        assertion: {
          capability: 'structured',
          report: {
            kind: 'stdout',
            spec: {
              collection: 'stdout' as const,
              transport: 'stdout' as const,
              format: 'go_test_json' as const,
              providerId: 'go_test' as const,
            },
          } satisfies PreparedAssertionReportStdout,
        },
      };
      const result = await collectAssertionReports(prepared, makeEvidence(''), '/tmp');
      expect(result.status).toBe('collected');
    });
  });

  describe('unsupported', () => {
    it('returns blocked for unsupported candidates', async () => {
      const prepared: PreparedVerificationExecution = {
        attemptId: 'run-1',
        kind: 'test',
        command: 'run',
        assertion: { capability: 'unsupported' },
      };
      const result = await collectAssertionReports(prepared, makeEvidence(''), '/tmp');
      expect(result.status).toBe('blocked');
    });
  });
});
