/** Active V2 demo pins are candidate selection, never historical V1 certification. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPins, assertToolchain } from '../../../demos/lib/toolchain.mjs';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

const REPO = path.resolve(__dirname, '../../..');
const CANDIDATE_FILE = '.sdk-baselines/opencode/cli-candidate.json';
const candidate = JSON.parse(readFileSync(path.join(REPO, CANDIDATE_FILE), 'utf8')) as {
  package: string;
  status: string;
  version: string;
};
const dirs: string[] = [];

function fixture(pin: unknown = candidate): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'fg-demo-pins-'));
  dirs.push(repo);
  mkdirSync(path.join(repo, '.sdk-baselines/opencode'), { recursive: true });
  mkdirSync(path.join(repo, 'src/cli'), { recursive: true });
  writeFileSync(path.join(repo, CANDIDATE_FILE), JSON.stringify(pin));
  writeFileSync(path.join(repo, '.node-version'), `${process.versions.node}\n`);
  // A conflicting old source pin must never influence the current reader.
  writeFileSync(
    path.join(repo, 'src/cli/opencode-runtime-compat.ts'),
    "export const TESTED_OPENCODE_HOST_VERSION = '1.19.5';\n",
  );
  return repo;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('active V2 demo candidate pins', () => {
  it('reads the actual candidate and Node authorities, not the historical source pin', () => {
    expect(readPins()).toEqual({
      opencode: candidate.version,
      node: readFileSync(path.join(REPO, '.node-version'), 'utf8').trim(),
    });
    expect(readPins(fixture()).opencode).toBe(candidate.version);
  });

  it('reads a changed candidate from the selected checkout without a hardcoded version', () => {
    expect(readPins(fixture({ ...candidate, version: '2.99.0' })).opencode).toBe('2.99.0');
  });

  it.each([
    null,
    {},
    { ...candidate, package: '@opencode-ai/cli' },
    { ...candidate, status: 'verified' },
    { ...candidate, version: '' },
    { ...candidate, version: 224 },
    { ...candidate, version: 'v2.2.4' },
    { ...candidate, version: '2.2.4-nightly' },
  ])('fails explicitly for an invalid candidate %j', (pin) => {
    expect(() => readPins(fixture(pin))).toThrow(
      expect.objectContaining({ code: 'OPENCODE_CANDIDATE_INVALID' }),
    );
  });

  it('does not fall back to the V1 source pin when the candidate is absent', () => {
    const repo = fixture();
    rmSync(path.join(repo, CANDIDATE_FILE));
    expect(() => readPins(repo)).toThrow(/ENOENT/);
  });

  it('rejects malformed JSON and an empty Node pin before any host command', () => {
    const repo = fixture();
    writeFileSync(path.join(repo, CANDIDATE_FILE), '{');
    expect(() => readPins(repo)).toThrow(SyntaxError);
    writeFileSync(path.join(repo, CANDIDATE_FILE), JSON.stringify(candidate));
    writeFileSync(path.join(repo, '.node-version'), '\n');
    expect(() => readPins(repo)).toThrow(expect.objectContaining({ code: 'NODE_PIN_INVALID' }));
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('uses the shared reader and check in the environment gate and matrix', () => {
    const gate = readFileSync(path.join(REPO, 'demos/lib/environment-gate.mjs'), 'utf8');
    expect(gate).toContain("from './toolchain.mjs'");
    expect(gate).toContain('readPins(options.repo)');
    expect(gate).toContain('assertToolchain(pins)');
    expect(gate).not.toContain('opencode-runtime-compat');
    for (const runner of [
      'java-task-manager/run-live-matrix.mjs',
      'java-task-manager/run-live-claim-controls.mjs',
      'risk-trigger-fixture/run-live-risk-trigger-controls.mjs',
      'risk-trigger-fixture/run-live-replan-recovery.mjs',
    ]) {
      const source = readFileSync(path.join(REPO, 'demos', runner), 'utf8');
      expect(source).toContain("import { readPins, assertToolchain } from '../lib/toolchain.mjs'");
      expect(source).not.toContain('export { readPins');
      expect(source).not.toContain('opencode-runtime-compat');
    }
  });
});

describe('exact V2 host version preflight', () => {
  const pins = { node: process.versions.node, opencode: candidate.version };

  it('accepts the exact candidate V2 CLI output including its final newline', () => {
    vi.mocked(execFileSync).mockReturnValue(`opencode v${pins.opencode}\n`);
    expect(assertToolchain(pins)).toEqual({
      nodeVersion: process.versions.node,
      opencodeVersion: `opencode v${pins.opencode}`,
    });
    expect(execFileSync).toHaveBeenCalledWith('opencode', ['--version'], { encoding: 'utf8' });
  });

  it.each([
    '1.19.5',
    'opencode v1.19.5',
    candidate.version,
    `v${candidate.version}`,
    'opencode v0.0.0',
    `opencode v${candidate.version}-nightly`,
    `warning\nopencode v${candidate.version}`,
    '',
  ])('rejects noncandidate or malformed output %j without normalization', (output) => {
    vi.mocked(execFileSync).mockReturnValue(output);
    expect(() => assertToolchain(pins)).toThrow(
      expect.objectContaining({ code: 'DEMO_TOOLCHAIN_MISMATCH' }),
    );
  });

  it('continues to reject a Node pin mismatch even with the correct host', () => {
    vi.mocked(execFileSync).mockReturnValue(`opencode v${pins.opencode}`);
    expect(() => assertToolchain({ ...pins, node: '0.0.0' })).toThrow(/node .* != pinned/);
  });

  it('surfaces an unsuccessful host probe rather than accepting a fallback', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('host executable unavailable'), { code: 'ENOENT' });
    });
    expect(() => assertToolchain(pins)).toThrow(/host executable unavailable/);
  });
});
