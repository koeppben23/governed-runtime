/**
 * @module rendering/mandates-renderer.test
 * @description Contract tests for the public API surface of mandates-renderer.
 *
 * Covers 7 of 9 publicly exported functions. Internal helpers and static
 * phase mappings are NOT tested in isolation — they are covered by the
 * integration-level install/doctor/status tool tests.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect } from 'vitest';
import { FLOWGUARD_MANDATES_BODY } from '../templates/mandates.js';
import {
  buildMandatesContent,
  extractManagedDigest,
  extractManagedVersion,
  isManagedArtifact,
  extractManagedBody,
  renderPhaseAwareMandates,
  renderCommandGovernanceRules,
} from './mandates-renderer.js';

const VALID_DIGEST = '0000000000000000000000000000000000000000000000000000000000000000';
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

  it('contains FLOWGUARD_MANDATES_BODY after the headers', () => {
    const content = managedArtifact();
    expect(content).toContain(FLOWGUARD_MANDATES_BODY);
  });
});

describe('extractManagedDigest', () => {
  it('extracts the 64-char hex digest from a managed artifact', () => {
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
  it('returns true for a managed artifact', () => {
    expect(isManagedArtifact(managedArtifact())).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isManagedArtifact('# Hello')).toBe(false);
  });
});

describe('extractManagedBody', () => {
  it('returns the body without headers (roundtrip)', () => {
    expect(extractManagedBody(managedArtifact())).toBe(FLOWGUARD_MANDATES_BODY);
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
