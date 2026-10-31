import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const facts = JSON.parse(
  readFileSync(
    new URL(
      '../../docs/host-probes/opencode-v2/2026-10-31-2.2.4-phase02/facts.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  decision: string;
  probeSourceSha256: Record<string, string>;
  nativeFixture: { status: string; productP000: string };
  commandOrigin: { candidateStatus: string; p001: string };
};

describe('Phase-02 observation scope and source-byte binding', () => {
  it('does not promote a passive fixture or negative-origin observation to product certification', () => {
    expect(facts.decision).toBe('NO-GO');
    expect(facts.nativeFixture.status).toBe('SUPPORTED');
    expect(facts.nativeFixture.productP000).toBe('NOT_VERIFIED');
    expect(facts.commandOrigin.candidateStatus).toBe('NOT_SUPPORTED');
    expect(facts.commandOrigin.p001).toBe('BLOCKED');
  });
  it('requires an explicit rerun/reassessment when observed probe-source bytes change', () => {
    for (const [path, expected] of Object.entries(facts.probeSourceSha256)) {
      const bytes = readFileSync(new URL(`./${path}`, import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(expected);
    }
  });

  it('preserves exact LF source bytes even with Git autocrlf enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-probe-checkout-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      git('init', '--quiet');
      git('config', 'core.autocrlf', 'true');
      git('config', 'core.eol', 'crlf');
      writeFileSync(
        join(root, '.gitattributes'),
        readFileSync(new URL('../../.gitattributes', import.meta.url)),
      );
      const bytes = Buffer.from('// evidence fixture\nexport const value = 1;\n');
      // Control proves this checkout would convert an unprotected text file.
      writeFileSync(join(root, 'unbound.mjs'), bytes);
      git('add', 'unbound.mjs');
      unlinkSync(join(root, 'unbound.mjs'));
      git('checkout-index', '--force', '--', 'unbound.mjs');
      expect(readFileSync(join(root, 'unbound.mjs'), 'utf8')).toBe(
        bytes.toString('utf8').replaceAll('\n', '\r\n'),
      );
      for (const path of ['lib/fixture.mjs', 'plugin/fixture.js', 'probes/fixture.mjs']) {
        const relative = `scripts/opencode-v2-probe/${path}`;
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
        git('add', '.gitattributes', relative);
        unlinkSync(target);
        git('checkout-index', '--force', '--', relative);
        expect(readFileSync(target), path).toEqual(bytes);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
