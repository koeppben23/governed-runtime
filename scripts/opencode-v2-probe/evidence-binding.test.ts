import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
});
