import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectAssertionReports } from './assertion-report-collector.js';
import type {
  PreparedVerificationExecution,
  PreparedAssertionReportRunSpecific,
  PreparedAssertionReportSnapshotDiff,
  PreparedAssertionReportStdout,
  ReportFileSnapshot,
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

  describe('snapshot_diff', () => {
    it('collects changed/new reports and ignores unchanged', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'fc-'));
      await mkdir(join(tmpDir, 'reports'), { recursive: true });

      // Pre-existing unchanging file
      const unchangedPath = join('reports', 'unchanged.xml');
      const unchangedContent = '<testsuite></testsuite>';
      await writeFile(join(tmpDir, unchangedPath), unchangedContent);

      const preSnapshot: ReportFileSnapshot[] = [
        { path: unchangedPath, digest: sha256(unchangedContent), size: unchangedContent.length },
      ];

      // After execution: unchanged file stays, new file appears
      const changedPath = join('reports', 'changed.xml');
      const changedContent = '<testsuite><testcase name="t"/></testsuite>';
      await writeFile(join(tmpDir, changedPath), changedContent);

      const prepared: PreparedVerificationExecution = {
        attemptId: 'run-1',
        kind: 'build',
        command: './mvnw test',
        assertion: {
          capability: 'structured',
          report: {
            kind: 'snapshot_diff',
            spec: {
              collection: 'snapshot_diff' as const,
              transport: 'file' as const,
              format: 'junit_xml' as const,
              providerId: 'junit' as const,
              standardPatterns: ['reports/TEST-*.xml', 'reports/*.xml'],
            },
            preExecutionSnapshot: preSnapshot,
          } satisfies PreparedAssertionReportSnapshotDiff,
        },
      };
      const result = await collectAssertionReports(prepared, makeEvidence(''), tmpDir);
      expect(result.status).toBe('collected');
      if (result.status === 'collected' && result.report.transport === 'file') {
        expect(result.report.reports).toHaveLength(1);
        expect(result.report.reports[0]!.path).toBe(changedPath);
        // Unchanged file must NOT be in reports
        expect(result.report.reports.find((r) => r.path === unchangedPath)).toBeUndefined();
      }
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('blocks when no reports changed', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'fc-'));
      await mkdir(join(tmpDir, 'reports'), { recursive: true });
      const unchangedPath = join('reports', 'unchanged.xml');
      const unchangedContent = '<testsuite></testsuite>';
      await writeFile(join(tmpDir, unchangedPath), unchangedContent);

      const preSnapshot: ReportFileSnapshot[] = [
        { path: unchangedPath, digest: sha256(unchangedContent), size: unchangedContent.length },
      ];

      const prepared: PreparedVerificationExecution = {
        attemptId: 'run-1',
        kind: 'build',
        command: './mvnw test',
        assertion: {
          capability: 'structured',
          report: {
            kind: 'snapshot_diff',
            spec: {
              collection: 'snapshot_diff' as const,
              transport: 'file' as const,
              format: 'junit_xml' as const,
              providerId: 'junit' as const,
              standardPatterns: ['reports/TEST-*.xml'],
            },
            preExecutionSnapshot: preSnapshot,
          } satisfies PreparedAssertionReportSnapshotDiff,
        },
      };
      const result = await collectAssertionReports(prepared, makeEvidence(''), tmpDir);
      expect(result.status).toBe('blocked');
      if (result.status === 'blocked') {
        expect(result.reasonCode).toBe('report_missing');
      }
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('collects deterministically sorted reports', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'fc-'));
      await mkdir(join(tmpDir, 'reports'), { recursive: true });

      const preSnapshot: ReportFileSnapshot[] = [];
      const paths = ['reports/z.xml', 'reports/a.xml', 'reports/m.xml'];
      for (const p of paths) {
        await writeFile(join(tmpDir, p), '<testsuite/>');
      }

      const prepared: PreparedVerificationExecution = {
        attemptId: 'run-1',
        kind: 'build',
        command: './mvnw test',
        assertion: {
          capability: 'structured',
          report: {
            kind: 'snapshot_diff',
            spec: {
              collection: 'snapshot_diff' as const,
              transport: 'file' as const,
              format: 'junit_xml' as const,
              providerId: 'junit' as const,
              standardPatterns: ['reports/*.xml'],
            },
            preExecutionSnapshot: preSnapshot,
          } satisfies PreparedAssertionReportSnapshotDiff,
        },
      };
      const result = await collectAssertionReports(prepared, makeEvidence(''), tmpDir);
      expect(result.status).toBe('collected');
      if (result.status === 'collected' && result.report.transport === 'file') {
        expect(result.report.reports).toHaveLength(3);
        expect(result.report.reports[0]!.path).toBe(join('reports', 'a.xml'));
        expect(result.report.reports[1]!.path).toBe(join('reports', 'm.xml'));
        expect(result.report.reports[2]!.path).toBe(join('reports', 'z.xml'));
      }
      await rm(tmpDir, { recursive: true, force: true });
    });
  });
});
