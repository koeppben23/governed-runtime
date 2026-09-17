/**
 * @module rendering/mandates-renderer.test
 * @description Contract tests for the public API surface of mandates-renderer.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FLOWGUARD_MANDATES_FULL_BODY,
  FLOWGUARD_MANDATES_KERNEL,
  MANDATES_SECTION_DEFINITIONS,
} from '../templates/mandates.js';
import {
  buildMandatesContent,
  extractManagedDigest,
  extractManagedVersion,
  isManagedArtifact,
  extractManagedBody,
  renderPhaseAwareMandates,
  renderCommandGovernanceRules,
  renderCompactionMandatesSummary,
  resolveMandatesVerbosity,
} from './mandates-renderer.js';

function sectionContent(section: (typeof MANDATES_SECTION_DEFINITIONS)[number]): string {
  return section.content;
}

function expectedSections(
  phase: string,
  predicate: (section: (typeof MANDATES_SECTION_DEFINITIONS)[number]) => boolean,
): string {
  return MANDATES_SECTION_DEFINITIONS.filter(
    (section) =>
      (section.phases === 'all' || (section.phases as readonly string[]).includes(phase)) &&
      predicate(section),
  )
    .sort((left, right) => left.priority - right.priority)
    .map(sectionContent)
    .join('\n\n');
}

const VALID_DIGEST = createHash('sha256').update(FLOWGUARD_MANDATES_KERNEL, 'utf-8').digest('hex');
const VALID_VERSION = '1.2.0-tp.1';

function managedArtifact(version = VALID_VERSION, digest = VALID_DIGEST): string {
  return buildMandatesContent(version, digest);
}

describe('buildMandatesContent', () => {
  it('produces a managed artifact with version header', () => {
    const content = managedArtifact();
    expect(content).toContain('<!-- @flowguard/core v1.2.0-tp.1');
    expect(content).toContain('managed artifact');
  });

  it('includes the content-digest header', () => {
    const content = managedArtifact();
    expect(content).toContain(`<!-- content-digest: sha256:${VALID_DIGEST} -->`);
  });

  it('contains FLOWGUARD_MANDATES_KERNEL after the headers', () => {
    const content = managedArtifact();
    expect(content).toContain(FLOWGUARD_MANDATES_KERNEL);
  });
});

describe('extractManagedDigest', () => {
  it('extracts the 64-char hex digest from a complete managed envelope', () => {
    expect(extractManagedDigest(managedArtifact())).toBe(VALID_DIGEST);
  });

  it('returns null for plain text', () => {
    expect(extractManagedDigest('# Hello')).toBeNull();
  });

  it('returns null for a partial/malformed header', () => {
    const bad = '<!-- content-digest: sha256:abc -->\n\nbody';
    expect(extractManagedDigest(bad)).toBeNull();
  });
});

describe('extractManagedVersion', () => {
  it('extracts the version from a managed artifact', () => {
    expect(extractManagedVersion(managedArtifact())).toBe(VALID_VERSION);
  });

  it('extracts a plain 1.2.0 version', () => {
    expect(extractManagedVersion(managedArtifact('1.2.0'))).toBe('1.2.0');
  });

  it('returns null for plain text', () => {
    expect(extractManagedVersion('# Hello')).toBeNull();
  });
});

describe('isManagedArtifact', () => {
  it('returns true only for a complete envelope whose body matches its digest', () => {
    expect(isManagedArtifact(managedArtifact())).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isManagedArtifact('# Hello')).toBe(false);
  });

  it('rejects a look-alike managed header with a forged digest', () => {
    expect(isManagedArtifact(managedArtifact(VALID_VERSION, '0'.repeat(64)))).toBe(false);
  });

  it('rejects a valid managed artifact after its body is modified', () => {
    const modified = managedArtifact().replace(
      '# FlowGuard Agent Rules',
      '# FlowGuard Agent Rules\ncustomer mutation',
    );
    expect(isManagedArtifact(modified)).toBe(false);
    expect(extractManagedBody(modified)).toBeNull();
  });

  it('rejects extra bytes before the managed envelope', () => {
    expect(isManagedArtifact(`customer prefix\n${managedArtifact()}`)).toBe(false);
  });
});

describe('extractManagedBody', () => {
  it('returns the body without headers (roundtrip)', () => {
    expect(extractManagedBody(managedArtifact())).toBe(FLOWGUARD_MANDATES_KERNEL);
  });

  it('returns null for non-managed content', () => {
    expect(extractManagedBody('# Hello')).toBeNull();
  });

  it('body contains the expected anchor text', () => {
    const body = extractManagedBody(managedArtifact());
    expect(body).toContain('# FlowGuard Agent Rules');
  });
});

describe('renderPhaseAwareMandates', () => {
  it('returns a non-empty string for ALL_PHASES', () => {
    const result = renderPhaseAwareMandates({}, 'ALL_PHASES');
    expect(result.trim().length).toBeGreaterThan(0);
    expect(result).toContain('# FlowGuard Agent Rules');
  });
});

describe('renderCommandGovernanceRules', () => {
  it('returns the governance rules section', () => {
    const result = renderCommandGovernanceRules();
    expect(result).toContain('## Governance rules');
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

describe('phase-aware mandate projection', () => {
  it('projects exactly the sections of the render phase in priority order', () => {
    const rendered = renderPhaseAwareMandates({}, 'IMPLEMENTATION');
    const expected = expectedSections('IMPLEMENTATION', () => true);

    expect(rendered).toBe(expected);
    expect(rendered).not.toBe(FLOWGUARD_MANDATES_FULL_BODY);
  });

  it('maps canonical phases onto their render phase', () => {
    const rendered = renderPhaseAwareMandates({}, 'PLAN_REVIEW');
    const expected = expectedSections('REVIEW', () => true);

    expect(rendered).toBe(expected);
  });

  it('applies the concise verbosity filter for concrete phases', () => {
    const rendered = renderPhaseAwareMandates({ mandatesVerbosity: 'concise' }, 'REVIEW');
    const expected = expectedSections(
      'REVIEW',
      (section) => section.safetyCritical === true || section.concise === true,
    );

    expect(rendered).toBe(expected);
  });

  it('applies the early-phase filter for investigation phases', () => {
    const rendered = renderPhaseAwareMandates({}, 'INVESTIGATION');
    const expected = expectedSections(
      'INVESTIGATION',
      (section) => section.safetyCritical === true || section.earlyPhase === true,
    );

    expect(rendered).toBe(expected);
  });

  it('falls back to the full body for progressive:false, unknown and ALL_PHASES inputs', () => {
    expect(renderPhaseAwareMandates({ progressive: false }, 'IMPLEMENTATION')).toBe(
      FLOWGUARD_MANDATES_FULL_BODY,
    );
    expect(renderPhaseAwareMandates({}, 'NOT_A_PHASE')).toBe(FLOWGUARD_MANDATES_FULL_BODY);
    expect(renderPhaseAwareMandates({}, undefined)).toBe(FLOWGUARD_MANDATES_FULL_BODY);
    expect(renderPhaseAwareMandates({}, 'ALL_PHASES')).toBe(FLOWGUARD_MANDATES_FULL_BODY);
  });
});

describe('mandates verbosity resolution', () => {
  it('resolves each declared verbosity value', () => {
    expect(resolveMandatesVerbosity('concise')).toBe('concise');
    expect(resolveMandatesVerbosity('explicit')).toBe('explicit');
    expect(resolveMandatesVerbosity(undefined)).toBe('explicit');
    expect(resolveMandatesVerbosity('unknown-value')).toBe('explicit');
  });

  it('grants the diagnostic summary only to recovery usage', () => {
    expect(resolveMandatesVerbosity('diagnosticSummary', 'recovery')).toBe('diagnosticSummary');
    expect(resolveMandatesVerbosity('diagnosticSummary', 'productive')).toBe('explicit');
  });
});

describe('compaction summary projection', () => {
  it('returns the kernel for fallback and ALL_PHASES phases', () => {
    expect(renderCompactionMandatesSummary(undefined)).toBe(FLOWGUARD_MANDATES_KERNEL);
    expect(renderCompactionMandatesSummary('ALL_PHASES')).toBe(FLOWGUARD_MANDATES_KERNEL);
    expect(renderCompactionMandatesSummary('NOT_A_PHASE')).toBe(FLOWGUARD_MANDATES_KERNEL);
  });

  it('projects only safety-critical sections for a concrete phase', () => {
    const summary = renderCompactionMandatesSummary('IMPLEMENTATION');
    const expected = expectedSections(
      'IMPLEMENTATION',
      (section) => section.safetyCritical === true,
    );

    expect(summary).toBe(expected);
    expect(summary).not.toBe(FLOWGUARD_MANDATES_FULL_BODY);
  });
});
