import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'verify-mutation-admission.mjs');
const baseConfig = JSON.parse(readFileSync(join(repoRoot, 'stryker.conf.json'), 'utf8')) as {
  mutate: string[];
};
const jwksConfig = JSON.parse(
  readFileSync(join(repoRoot, 'stryker.identity-jwks.conf.json'), 'utf8'),
) as { mutate: string[] };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Mutant {
  readonly id: string;
  readonly mutatorName: string;
  readonly status: string;
  readonly location: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
}

interface FileEntry {
  readonly language: string;
  readonly source: string;
  readonly mutants: readonly Mutant[];
}

interface Report {
  schemaVersion: string;
  thresholds: { high: number; low: number; break: number };
  files: Record<string, FileEntry>;
}

let mutantCounter = 0;

function mutant(status: string, line: number): Mutant {
  mutantCounter++;
  return {
    id: String(mutantCounter),
    mutatorName: 'EqualityOperator',
    status,
    location: {
      start: { line, column: 1 },
      end: { line, column: 10 },
    },
  };
}

function mutants(statuses: readonly string[], startLine = 10): Mutant[] {
  return statuses.map((status, index) => mutant(status, startLine + index));
}

function fileEntry(mutantsList: readonly Mutant[]): FileEntry {
  return { language: 'typescript', source: '', mutants: mutantsList };
}

function emptyTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flowguard-admission-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeReport(report: Report): string {
  const reportPath = join(emptyTemporaryDirectory(), 'mutation.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return reportPath;
}

function baseReport(): Report {
  const files: Record<string, FileEntry> = {};
  for (const selector of baseConfig.mutate) {
    files[selector] = fileEntry(mutants(['Killed', 'Killed', 'Killed', 'Timeout']));
  }
  return { schemaVersion: '1.0', thresholds: { high: 85, low: 80, break: 80 }, files };
}

const KILLED_SET = ['Killed', 'Killed', 'Killed', 'Timeout'];

function jwksReport(
  mutantsByRange: { readonly [range: string]: readonly Mutant[] },
  options: { readonly outsideRange?: boolean } = {},
): Report {
  const outside =
    options.outsideRange === true ? mutants(['Survived', 'Survived', 'Survived'], 100) : [];
  const all = [...outside, ...Object.values(mutantsByRange).flat()];
  return {
    schemaVersion: '1.0',
    thresholds: { high: 85, low: 80, break: 80 },
    files: { 'src/identity/key-resolver.ts': fileEntry(all) },
  };
}

function runVerifier(args: readonly string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('verify-mutation-admission', () => {
  it('accepts a full run where every target meets the break threshold', () => {
    const reportPath = writeReport(baseReport());

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`targets=${baseConfig.mutate.length}`);
    expect(result.stdout).toContain('OK');
  });

  it('rejects a required target below the break threshold', () => {
    const report = baseReport();
    report.files['src/adapters/ip-validation.ts'] = fileEntry(
      mutants(['Killed', 'Survived', 'Survived']),
    );
    const reportPath = writeReport(report);

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--require-selectors',
      'src/adapters/ip-validation.ts',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/adapters/ip-validation.ts');
    expect(result.stderr).toContain('33.33% < 80% (required per-target)');
  });

  it('accepts a legacy target below the per-target threshold while the aggregate holds', () => {
    const report = baseReport();
    report.files['src/adapters/ip-validation.ts'] = fileEntry(
      mutants(['Killed', 'Survived', 'Survived', 'Survived']),
    );
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 legacy target(s) below the per-target threshold');
    expect(result.stdout).toContain('src/adapters/ip-validation.ts');
  });

  it('rejects a selector that is not part of the profile', () => {
    const reportPath = writeReport(baseReport());

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--require-selectors',
      'src/machine/topology.ts',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not in stryker.conf.json');
  });

  it('counts only Killed and Timeout as detected (RuntimeError is excluded)', () => {
    const report = baseReport();
    report.files['src/adapters/ip-validation.ts'] = fileEntry(
      mutants(['Killed', 'Killed', 'Killed', 'Survived', 'RuntimeError', 'RuntimeError']),
    );
    const reportPath = writeReport(report);

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--require-selectors',
      'src/adapters/ip-validation.ts',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('75.00% < 80% (required per-target)');
  });

  it('accepts Pending as a known excluded status', () => {
    const report = baseReport();
    report.files['src/audit/ntp-check.ts'] = fileEntry(
      mutants(['Killed', 'Killed', 'Killed', 'Killed', 'Pending', 'CompileError']),
    );
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(0);
  });

  it('rejects a target whose mutants are all excluded', () => {
    const report = baseReport();
    report.files['src/audit/ntp-check.ts'] = fileEntry(mutants(['RuntimeError', 'Ignored']));
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/audit/ntp-check.ts: no valid mutants');
  });

  it('rejects a required target missing from the report', () => {
    const report = baseReport();
    delete report.files['src/audit/integrity.ts'];
    const reportPath = writeReport(report);

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--require-selectors',
      'src/audit/integrity.ts',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/audit/integrity.ts: missing from report');
  });

  it('rejects a legacy target missing from the report (fail closed)', () => {
    const report = baseReport();
    delete report.files['src/adapters/ip-validation.ts'];
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'src/adapters/ip-validation.ts: missing from report (configured selector produced no mutants)',
    );
  });

  it('rejects every configured selector that vanishes from the report', () => {
    const report = baseReport();
    for (const selector of baseConfig.mutate.slice(0, 3)) {
      delete report.files[selector];
    }
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('3 violation(s)');
  });

  it('rejects unknown mutant statuses instead of ignoring them', () => {
    const report = baseReport();
    report.files['src/audit/ntp-check.ts'] = fileEntry([mutant('Exploded', 10)]);
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("status 'Exploded' is not a known mutant status");
  });

  it('rejects reports that do not match the mutation report schema', () => {
    const report = baseReport();
    report.files['src/audit/ntp-check.ts'] = fileEntry([
      { id: '1', mutatorName: 'EqualityOperator', status: 'Killed' } as unknown as Mutant,
    ]);
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the report schema');
    expect(result.stderr).toContain('.location missing');
  });

  it('rejects a report that contains files outside the selected profile', () => {
    const report = baseReport();
    report.files['src/state/evidence-validation.ts'] = fileEntry(mutants(KILLED_SET));
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'base', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('1 file(s) are not base targets');
  });

  it('fails closed when the report is missing', () => {
    const result = runVerifier(['--profile', 'base', '--report', '/nonexistent/mutation.json']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mutation report not found');
  });

  it('scores range selectors only over mutants inside the declared range', () => {
    const report = jwksReport({
      '270-277': mutants(KILLED_SET, 272),
      '328-334': mutants(KILLED_SET, 330),
      '338-350': mutants(KILLED_SET, 340),
    });
    const reportPath = writeReport(report);

    const result = runVerifier([
      '--profile',
      'identity-jwks',
      '--report',
      reportPath,
      '--require-selectors',
      jwksConfig.mutate.join(','),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`targets=${jwksConfig.mutate.length}`);
    expect(result.stdout).toContain('OK');
  });

  it('rejects a required range whose mutants do not meet the threshold', () => {
    const report = jwksReport({
      '270-277': mutants(KILLED_SET, 272),
      '328-334': mutants(KILLED_SET, 330),
      '338-350': mutants(['Killed', 'Survived', 'Survived', 'Survived'], 340),
    });
    const reportPath = writeReport(report);

    const result = runVerifier([
      '--profile',
      'identity-jwks',
      '--report',
      reportPath,
      '--require-selectors',
      'src/identity/key-resolver.ts:338-350',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/identity/key-resolver.ts:338-350');
    expect(result.stderr).toContain('25.00% < 80% (required per-target)');
  });

  it('rejects a range report containing mutants outside every configured range', () => {
    const report = jwksReport(
      {
        '270-277': mutants(KILLED_SET, 272),
        '328-334': mutants(KILLED_SET, 330),
        '338-350': mutants(KILLED_SET, 340),
      },
      { outsideRange: true },
    );
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'identity-jwks', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mutant(s) outside every configured range');
  });

  it('rejects a range without any valid mutant inside the declared range', () => {
    const report = jwksReport({
      '270-277': mutants(KILLED_SET, 272),
      '338-350': mutants(KILLED_SET, 340),
    });
    const reportPath = writeReport(report);

    const result = runVerifier(['--profile', 'identity-jwks', '--report', reportPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no valid mutants inside the declared range');
  });

  it('writes and verifies an admission manifest', () => {
    const reportPath = writeReport(baseReport());
    const manifestPath = join(emptyTemporaryDirectory(), 'admission-manifest.json');

    const writeResult = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--write-manifest',
      manifestPath,
    ]);
    expect(writeResult.status).toBe(0);
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.profile).toBe('base');
    expect(manifest.configDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.reportDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const verifyResult = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--manifest',
      manifestPath,
    ]);
    expect(verifyResult.status).toBe(0);
  });

  it('rejects a manifest whose report digest no longer matches', () => {
    const reportPath = writeReport(baseReport());
    const manifestPath = join(emptyTemporaryDirectory(), 'admission-manifest.json');
    runVerifier(['--profile', 'base', '--report', reportPath, '--write-manifest', manifestPath]);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.reportDigest = 'a'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--manifest',
      manifestPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reportDigest does not match the current report bytes');
  });

  it('rejects a manifest bound to a different commit', () => {
    const reportPath = writeReport(baseReport());
    const manifestPath = join(emptyTemporaryDirectory(), 'admission-manifest.json');
    runVerifier(['--profile', 'base', '--report', reportPath, '--write-manifest', manifestPath]);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.commitSha = 'b'.repeat(40);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--manifest',
      manifestPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('commitSha');
  });

  it('refuses to emit admission records without a manifest', () => {
    const reportPath = writeReport(baseReport());

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--require-selectors',
      'src/adapters/ip-validation.ts',
      '--emit-admission',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--emit-admission requires --manifest');
  });

  it('refuses to emit admission records without required selectors', () => {
    const reportPath = writeReport(baseReport());
    const manifestPath = join(emptyTemporaryDirectory(), 'admission-manifest.json');
    runVerifier(['--profile', 'base', '--report', reportPath, '--write-manifest', manifestPath]);

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--manifest',
      manifestPath,
      '--emit-admission',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--emit-admission requires --require-selectors');
  });

  it('emits admission records with provenance from the verified manifest', () => {
    const reportPath = writeReport(baseReport());
    const manifestPath = join(emptyTemporaryDirectory(), 'admission-manifest.json');
    runVerifier(['--profile', 'base', '--report', reportPath, '--write-manifest', manifestPath]);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    const result = runVerifier([
      '--profile',
      'base',
      '--report',
      reportPath,
      '--manifest',
      manifestPath,
      '--require-selectors',
      'src/adapters/ip-validation.ts',
      '--emit-admission',
    ]);

    expect(result.status).toBe(0);
    const emitted = JSON.parse(result.stdout) as Array<{
      target: string;
      profile: string;
      score: number;
      admission: {
        commitSha: string;
        scoreAtAdmission: number;
        config: string;
        verifiedAt: string;
        reportDigest: string;
      };
    }>;
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.target).toBe('src/adapters/ip-validation.ts');
    expect(emitted[0]?.admission.commitSha).toBe(manifest.commitSha);
    expect(emitted[0]?.admission.scoreAtAdmission).toBe(emitted[0]?.score);
    expect(emitted[0]?.admission.config).toBe('stryker.conf.json');
    expect(emitted[0]?.admission.verifiedAt).toBe(manifest.generatedAt.slice(0, 10));
    expect(emitted[0]?.admission.reportDigest).toBe(manifest.reportDigest);
  });
});
