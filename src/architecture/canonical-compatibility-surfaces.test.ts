import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC_DIR = join(__dirname, '..');

async function source(relativePath: string): Promise<string> {
  return readFile(join(SRC_DIR, relativePath), 'utf-8');
}

describe('canonical compatibility surfaces', () => {
  it('does not restore removed review and repository-path wrappers', async () => {
    const [sharedHelpers, repositoryPath] = await Promise.all([
      source('integration/review/shared-helpers.ts'),
      source('state/repository-path.ts'),
    ]);

    expect(sharedHelpers).not.toContain('isStrictEnforcementEnabled');
    expect(sharedHelpers).not.toContain('getReviewerPolicies');
    expect(repositoryPath).not.toContain('normalizeRepositoryPath');
  });

  it('keeps state-owned schemas out of historical forwarding modules', async () => {
    const [discoveryTypes, identityTypes, auditTypes] = await Promise.all([
      source('discovery/types.ts'),
      source('identity/types.ts'),
      source('audit/types.ts'),
    ]);

    expect(discoveryTypes).not.toMatch(/export\s*\{[\s\S]*DiscoverySummarySchema/);
    expect(identityTypes).not.toMatch(/export\s*\{[\s\S]*IdpConfigSchema/);
    expect(auditTypes).not.toMatch(/export\s+type\s*\{[^}]*ActorInfo/);
  });

  it('does not restore installer forwarding re-exports', async () => {
    const helpers = await source('cli/install-helpers.ts');

    expect(helpers).not.toContain('re-export everything from split modules');
    expect(helpers).not.toMatch(/export\s*\{[\s\S]*mergeOpencodeJson/);
    expect(helpers).not.toMatch(/export\s*\{[\s\S]*PACKAGE_VERSION/);
  });

  it('keeps dead legacy-tolerance surfaces out of the audit verification result', async () => {
    const [integrity, summary, archiveVerifyChain] = await Promise.all([
      source('audit/integrity.ts'),
      source('audit/summary.ts'),
      source('adapters/workspace/archive-verify-chain.ts'),
    ]);

    // verifyChain has no strict-vs-legacy mode and never skips records: an
    // always-zero `skippedCount` would be a dead legacy result surface.
    expect(integrity).not.toContain('skippedCount');
    expect(integrity).not.toContain('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
    expect(summary).not.toContain('skippedCount');
    expect(archiveVerifyChain).not.toContain('skippedCount');
  });

  it('keeps current-facing documentation off removed audit and discovery contracts', async () => {
    const [configuration, hardening] = await Promise.all([
      readFile(join(SRC_DIR, '..', 'docs', 'configuration.md'), 'utf-8'),
      readFile(join(SRC_DIR, '..', 'docs', 'security-hardening.md'), 'utf-8'),
    ]);

    for (const doc of [configuration, hardening]) {
      expect(doc).not.toContain('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
      expect(doc).not.toContain('skippedCount');
      expect(doc).not.toMatch(/verifyChain[^\n]*\{\s*strict:/);
    }
    expect(configuration).not.toContain('`validationHints` field in `DiscoveryResult` is a legacy');
  });
});
