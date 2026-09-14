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
});
