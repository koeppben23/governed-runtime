import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkHostVersion, run } from '../check-opencode-host-drift.mjs';

const candidate = JSON.parse(
  readFileSync(
    new URL('../../.sdk-baselines/opencode/cli-candidate.json', import.meta.url),
    'utf8',
  ),
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('exact V2 CLI candidate drift check', () => {
  it('accepts only the current candidate without certifying product or Desktop', () => {
    const message = checkHostVersion(candidate, `opencode v${candidate.version}\n`);
    expect(message).toContain('candidate matches');
    expect(message).toContain('not ACTIVE product or Desktop certification');
  });

  it.each([
    '1.19.5',
    'opencode v1.19.5',
    'opencode v2.2.4',
    'opencode v2.2.6',
    `opencode v${candidate.version}-nightly.20261111`,
    `opencode v${candidate.version}+unverified`,
    `untrusted opencode v${candidate.version}`,
    `${candidate.version}`,
    '',
    null,
  ])('rejects non-exact output %j', (reported) => {
    expect(() => checkHostVersion(candidate, reported)).toThrow(
      expect.objectContaining({ code: 'OPENCODE_HOST_VERSION_MISMATCH' }),
    );
  });

  it.each([
    null,
    {},
    { ...candidate, package: 'opencode-ai' },
    { ...candidate, status: 'certified' },
    { ...candidate, version: '1.19.5' },
    { ...candidate, version: '2.2.5-nightly' },
    { ...candidate, version: 225 },
  ])('rejects invalid candidate metadata %j', (pin) => {
    expect(() => checkHostVersion(pin, `opencode v${candidate.version}`)).toThrow(
      expect.objectContaining({ code: 'OPENCODE_CANDIDATE_INVALID' }),
    );
  });

  it('rejects the removed host-update trigger rather than claiming acceptance', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(run(['--trigger'])).toBe(1);
  });

  it('fails explicitly for a missing executable without installing a fallback', () => {
    vi.stubEnv('OPENCODE_CLI', '/nonexistent/flowguard-host-probe');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(run([])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('OPENCODE_HOST_PROBE_FAILED'),
    );
  });

  it('rejects successful but malformed executable output', () => {
    vi.stubEnv('OPENCODE_CLI', process.execPath); // node --version is not an OpenCode candidate
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(run([])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('OPENCODE_HOST_VERSION_MISMATCH'),
    );
  });

  it('active host tools read the candidate, not the historical host baseline', () => {
    for (const file of [
      'scripts/check-opencode-host-drift.mjs',
      '.github/workflows/proofgraph-live-controls.yml',
    ]) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(source).toContain('cli-candidate.json');
      expect(source).not.toContain('host-version.json');
      expect(source).not.toContain('opencode-ai');
    }
  });
});
