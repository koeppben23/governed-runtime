import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'verify-mutation-admission.mjs');
const baseConfig = JSON.parse(readFileSync(join(repoRoot, 'stryker.conf.json'), 'utf8')) as {
  mutate: string[];
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function targetOf(selector: string): string {
  const separator = selector.lastIndexOf(':');
  if (separator === -1) return selector;
  const suffix = selector.slice(separator + 1);
  return /^\d+-\d+$/.test(suffix) ? selector.slice(0, separator) : selector;
}

interface Mutant {
  readonly status: string;
}

function writeReport(files: Record<string, readonly Mutant[]>): string {
  const directory = mkdtempSync(join(tmpdir(), 'flowguard-admission-'));
  temporaryDirectories.push(directory);
  const reportPath = join(directory, 'mutation.json');
  const reportFiles = Object.fromEntries(
    Object.entries(files).map(([target, mutants]) => [
      target,
      { language: 'typescript', source: '', mutants },
    ]),
  );
  writeFileSync(reportPath, JSON.stringify({ files: reportFiles }, null, 2), 'utf8');
  return reportPath;
}

function killedMutants(): Mutant[] {
  return [{ status: 'Killed' }, { status: 'Killed' }, { status: 'Killed' }, { status: 'Timeout' }];
}

function fullReport(
  override?: (target: string) => readonly Mutant[] | undefined,
): Record<string, readonly Mutant[]> {
  const files: Record<string, readonly Mutant[]> = {};
  for (const selector of baseConfig.mutate) {
    const target = targetOf(selector);
    files[target] = override?.(target) ?? killedMutants();
  }
  return files;
}

function runVerifier(args: readonly string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('verify-mutation-admission', () => {
  it('accepts a full run where every target meets the break threshold', () => {
    const reportPath = writeReport(fullReport());

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`targets=${baseConfig.mutate.length}`);
    expect(result.stdout).toContain('OK');
  });

  it('rejects a target below the break threshold', () => {
    const reportPath = writeReport(
      fullReport((target) =>
        target === 'src/adapters/ip-validation.ts'
          ? [{ status: 'Killed' }, { status: 'Survived' }, { status: 'Survived' }]
          : undefined,
      ),
    );

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/adapters/ip-validation.ts');
    expect(result.stderr).toContain('33.33% < 80%');
  });

  it('rejects a target missing from the report', () => {
    const files = fullReport();
    delete files['src/audit/integrity.ts'];
    const reportPath = writeReport(files);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/audit/integrity.ts: missing from report');
  });

  it('rejects unknown mutant statuses instead of ignoring them', () => {
    const reportPath = writeReport(
      fullReport((target) =>
        target === 'src/audit/ntp-check.ts' ? [{ status: 'Exploded' }] : undefined,
      ),
    );

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown mutant status 'Exploded'");
  });

  it('fails closed when the report is missing', () => {
    const result = runVerifier(['--profile', 'base', '--report', '/nonexistent/mutation.json']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mutation report not found');
  });

  it('emits inventory-compatible admission records', () => {
    const reportPath = writeReport(fullReport());

    const result = runVerifier(['--profile', 'base', '--report', reportPath, '--emit-admission']);

    expect(result.status).toBe(0);
    const emitted = JSON.parse(result.stdout) as Array<{
      target: string;
      profile: string;
      score: number;
      admission: { scoreAtAdmission: number; config: string; verifiedAt: string };
    }>;
    expect(emitted).toHaveLength(baseConfig.mutate.length);
    expect(emitted[0]?.profile).toBe('base');
    expect(emitted[0]?.admission.scoreAtAdmission).toBe(emitted[0]?.score);
    expect(emitted[0]?.admission.config).toBe('stryker.conf.json');
    expect(emitted[0]?.admission.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
