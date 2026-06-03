/**
 * @module cli/doctor-executable-logging.test
 * @description #423 boundary test — the CLI doctor closure (the only logger
 * writer) emits a structured `error` per failing shipped executable and exits
 * non-zero. doctor (rails) is mocked to return crafted checks so the boundary
 * behavior is asserted in isolation.
 *
 * @test-policy BAD, CORNER
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { withTestEnv } from '../integration/test-helpers.js';
import { resetAdapterLogger } from '../logging/adapter-logger.js';
import { SHIPPED_EXECUTABLE_CHECK, resolvePackageRoot } from './install-helpers.js';

vi.mock('./doctor-command.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./doctor-command.js')>();
  return { ...actual, doctor: vi.fn() };
});

import { main } from './install.js';
import { doctor } from './doctor-command.js';

async function runDoctorCapturingStderr(): Promise<{ output: string; code: number }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-bin-log-'));
  const restoreEnv = withTestEnv({
    OPENCODE_CONFIG_DIR: tmpDir,
    FLOWGUARD_REQUIRE_TEST_CONFIG_DIR: '1',
  });
  await fs.mkdir(path.join(tmpDir, '.git'));
  const captured: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    captured.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    const code = await main(['doctor', '--install-scope', 'repo', '--log-mode', 'console']);
    return { output: captured.join(''), code };
  } finally {
    restoreEnv();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('doctor shipped-executable boundary logging (#423)', () => {
  beforeEach(() => resetAdapterLogger());
  afterEach(() => {
    resetAdapterLogger();
    vi.restoreAllMocks();
  });

  it('emits an error log with package-relative path + check per failing executable, exit 1', async () => {
    const missingFile = path.join(resolvePackageRoot(), 'dist', 'cli', 'install.js');
    vi.mocked(doctor).mockResolvedValue([
      { file: '/cfg/mandates.md', status: 'ok' },
      {
        file: missingFile,
        status: 'missing',
        detail: 'shipped executable not found',
        check: SHIPPED_EXECUTABLE_CHECK,
      },
    ]);

    const { output, code } = await runDoctorCapturingStderr();

    expect(output).toContain('[ERROR]');
    expect(output).toContain('shipped executable invalid');
    expect(output).toContain(SHIPPED_EXECUTABLE_CHECK);
    expect(output).toContain('dist/cli/install.js');
    // package-relative path, not the absolute one
    expect(output).not.toContain(missingFile);
    expect(code).toBe(1);
  });

  it('does not emit an executable error log when all checks pass, exit 0', async () => {
    vi.mocked(doctor).mockResolvedValue([
      { file: '/cfg/mandates.md', status: 'ok' },
      {
        file: path.join(resolvePackageRoot(), 'dist', 'cli', 'install.js'),
        status: 'ok',
        check: SHIPPED_EXECUTABLE_CHECK,
      },
    ]);

    const { output, code } = await runDoctorCapturingStderr();

    expect(output).not.toContain('shipped executable invalid');
    expect(code).toBe(0);
  });
});
