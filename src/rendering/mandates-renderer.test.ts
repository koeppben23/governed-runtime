/**
 * @module rendering/mandates-renderer.test
 * @description Contract tests for the public API surface of mandates-renderer.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FLOWGUARD_MANDATES_KERNEL } from '../templates/mandates.js';
import {
  buildMandatesContent,
  extractManagedDigest,
  extractManagedVersion,
  isManagedArtifact,
  extractManagedBody,
  renderPhaseAwareMandates,
  renderCommandGovernanceRules,
} from './mandates-renderer.js';

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
