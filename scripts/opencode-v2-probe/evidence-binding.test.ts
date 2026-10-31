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

const scopeFacts = JSON.parse(
  readFileSync(
    new URL(
      '../../docs/host-probes/opencode-v2/2026-10-31-2.2.4-scope-lifecycle/facts.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  decision: string;
  p002H: string;
  operatorAuthority: string;
  probeSourceSha256: Record<string, string>;
  observations: {
    sdkParentClaimAccepted: boolean;
    crashWaitReturned: boolean;
    crashOutcomeAfterWait: null;
  };
};

const preventionFacts = JSON.parse(
  readFileSync(
    new URL(
      '../../docs/host-probes/opencode-v2/2026-10-31-2.2.4-prevention-review/facts.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  decision: string;
  p004: string;
  p005: string;
  p001: string;
  probeSourceSha256: Record<string, string>;
  mcp: { preEffectControl: string; positiveControlExecuted: boolean };
  hosted: { universalProviderContainment: string; providerExecutedStatus: string };
  shell: { shellBeforePromptHook: boolean; toolFenceObserved: boolean };
  reviewer: {
    simpleAssuranceValid: boolean;
    naiveLatestAnswerAfterReuse: string;
    exactOriginalChainStillBound: boolean;
    toolAttemptDeniedBeforeEffect: boolean;
    fullReviewerAssurance: string;
  };
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

  it('binds the scope follow-up without upgrading caller parentage or a post-crash wait to assurance', () => {
    expect(scopeFacts.decision).toBe('NO-GO');
    expect(scopeFacts.p002H).toBe('NOT_VERIFIED');
    expect(scopeFacts.operatorAuthority).toBe('BLOCKED');
    expect(scopeFacts.observations.sdkParentClaimAccepted).toBe(true);
    expect(scopeFacts.observations.crashWaitReturned).toBe(true);
    expect(scopeFacts.observations.crashOutcomeAfterWait).toBeNull();
    for (const [path, expected] of Object.entries(scopeFacts.probeSourceSha256)) {
      expect(
        createHash('sha256')
          .update(readFileSync(new URL(`./${path}`, import.meta.url)))
          .digest('hex'),
        path,
      ).toBe(expected);
    }
  });

  it('keeps the prevention/reviewer results bounded and rejects latest-answer capture', () => {
    expect(preventionFacts.decision).toBe('NO-GO');
    expect(preventionFacts.p004).toBe('NOT_VERIFIED');
    expect(preventionFacts.p005).toBe('NOT_VERIFIED');
    expect(preventionFacts.p001).toBe('BLOCKED');
    expect(preventionFacts.mcp.preEffectControl).toBe('SUPPORTED_BOUNDED');
    expect(preventionFacts.mcp.positiveControlExecuted).toBe(true);
    expect(preventionFacts.hosted.universalProviderContainment).toBe('NOT_SUPPORTED');
    expect(preventionFacts.hosted.providerExecutedStatus).toBe('NOT_VERIFIED');
    expect(preventionFacts.shell.shellBeforePromptHook).toBe(true);
    expect(preventionFacts.shell.toolFenceObserved).toBe(false);
    expect(preventionFacts.reviewer.simpleAssuranceValid).toBe(true);
    expect(preventionFacts.reviewer.naiveLatestAnswerAfterReuse).toBe('FORGED_AFTER_TERMINAL');
    expect(preventionFacts.reviewer.exactOriginalChainStillBound).toBe(true);
    expect(preventionFacts.reviewer.toolAttemptDeniedBeforeEffect).toBe(true);
    expect(preventionFacts.reviewer.fullReviewerAssurance).toBe('NOT_VERIFIED');
    for (const [path, expected] of Object.entries(preventionFacts.probeSourceSha256)) {
      expect(
        createHash('sha256')
          .update(readFileSync(new URL(`./${path}`, import.meta.url)))
          .digest('hex'),
        path,
      ).toBe(expected);
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
