import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReportIsolation, reportMatchesExecutionWindow } from './report-isolation.js';

describe('attempt-local report isolation (not attestation)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'fg-report-isolation-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  const report = '.flowguard/reports/attempt/report.json';
  it('creates a fresh directory, accepts a current file and refuses attempt reuse', async () => {
    const started = new Date().toISOString();
    await prepareReportIsolation(cwd, 'attempt', report);
    await writeFile(join(cwd, report), '{}');
    expect(await reportMatchesExecutionWindow(cwd, report, 'attempt', started, 1000)).toBe(true);
    await expect(prepareReportIsolation(cwd, 'attempt', report)).rejects.toMatchObject({
      code: 'VERIFICATION_REPORT_ISOLATION_FAILED',
    });
  });
  it('rejects pre-existing stale report bytes', async () => {
    await prepareReportIsolation(cwd, 'attempt', report);
    await writeFile(join(cwd, report), '{}');
    await utimes(join(cwd, report), new Date(0), new Date(0));
    expect(
      await reportMatchesExecutionWindow(cwd, report, 'attempt', new Date().toISOString(), 1000),
    ).toBe(false);
  });
  it('rejects foreign output patterns and symlinked report ancestry', async () => {
    await expect(prepareReportIsolation(cwd, 'attempt', '../report.json')).rejects.toMatchObject({
      code: 'VERIFICATION_REPORT_ISOLATION_FAILED',
    });
    const outside = join(cwd, 'outside');
    await mkdir(outside);
    await symlink(
      outside,
      join(cwd, '.flowguard'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(prepareReportIsolation(cwd, 'attempt', report)).rejects.toMatchObject({
      code: 'VERIFICATION_REPORT_ISOLATION_FAILED',
    });
  });
});
