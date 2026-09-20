import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SRC_DIR = join(__dirname, '..');

async function source(relativePath: string): Promise<string> {
  return readFile(join(SRC_DIR, relativePath), 'utf-8');
}

async function sourceFiles(relativeDirectory: string): Promise<string[]> {
  const directory = join(SRC_DIR, relativeDirectory);
  const entries = await readdir(directory, { recursive: true });
  return Promise.all(
    entries
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
      .map((entry) => readFile(join(directory, entry), 'utf-8')),
  );
}

function exportsIdentifier(module: string, identifier: string): boolean {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `export\\s+(?:(?:declare\\s+)?(?:async\\s+)?(?:const|let|var|function|class|interface|type)\\s+${escapedIdentifier}\\b|\\{[^}]*\\b${escapedIdentifier}\\b[^}]*\\})`,
  ).test(module);
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

  it('pins identifiers to their direct canonical owners', async () => {
    const [sharedIdentifiers, evidenceIdentifiers, repositoryFingerprint, policyIdpConfig] =
      await Promise.all([
        source('shared/flowguard-identifiers.ts'),
        source('state/evidence-identifiers.ts'),
        source('shared/repository-fingerprint.ts'),
        source('shared/policy-idp-config.ts'),
      ]);

    expect(sharedIdentifiers).not.toMatch(/from\s+['"][^'"]*state\/evidence-identifiers\.js['"]/);
    for (const identifier of [
      'REVIEW_REPORT_SCHEMA_ID',
      'POLICY_DIGEST_VERSION',
      'POLICY_DIGEST_PATTERN',
    ]) {
      expect(exportsIdentifier(sharedIdentifiers, identifier)).toBe(false);
    }
    expect(repositoryFingerprint).toMatch(/export\s+const\s+FINGERPRINT_PATTERN\s*=/);
    expect(exportsIdentifier(evidenceIdentifiers, 'FINGERPRINT_PATTERN')).toBe(false);
    expect(policyIdpConfig).toMatch(/export\s+const\s+IdpConfigSchema\s*=/);
    await expect(source('state/policy-idp-config.ts')).rejects.toThrow();
  });

  it('keeps dead legacy-tolerance surfaces out of the audit verification result', async () => {
    const [integrity, summary, archiveVerifyChain, persistenceAudit, archiveTypes] =
      await Promise.all([
        source('audit/integrity.ts'),
        source('audit/summary.ts'),
        source('adapters/workspace/archive-verify-chain.ts'),
        source('adapters/persistence-audit.ts'),
        source('archive/types.ts'),
      ]);

    // verifyChain has no strict-vs-legacy mode and never skips records: an
    // always-zero `skippedCount` would be a dead legacy result surface.
    expect(integrity).not.toContain('skippedCount');
    expect(integrity).not.toContain('LEGACY_EVENTS_NOT_ALLOWED_IN_STRICT_MODE');
    expect(summary).not.toContain('skippedCount');
    expect(archiveVerifyChain).not.toContain('skippedCount');
    // readAuditTrail either returns every canonical audit-chain.v3 event or
    // fails closed: a tolerance/skip result surface cannot come back.
    expect(persistenceAudit).not.toMatch(/skipped\s*:/);
    expect(persistenceAudit).not.toMatch(/\{\s*events\s*,\s*skipped\s*\}/);
    expect(archiveTypes).not.toContain('audit_records_skipped');
  });

  it('does not restore removed compatibility projections or absent attempt lineage handling', async () => {
    const [helpers, structuredEvidenceResolver, reviewTool, envelopeReasons, evidenceRefinements] =
      await Promise.all([
        source('integration/tools/helpers.ts'),
        source('integration/review/review-validation-structured-evidence.ts'),
        source('integration/tools/review-tool/index.ts'),
        source('config/reasons-envelope.ts'),
        source('state/evidence-review-refinements.ts'),
      ]);

    expect(exportsIdentifier(helpers, 'appendNextAction')).toBe(false);
    expect(exportsIdentifier(helpers, 'extractSections')).toBe(false);
    const commandSources = await sourceFiles('templates/commands');
    for (const module of [
      ...commandSources,
      structuredEvidenceResolver,
      reviewTool,
      envelopeReasons,
      evidenceRefinements,
    ]) {
      expect(module).not.toContain('GOVERNANCE_RULES');
      expect(module).not.toContain('REVIEW_ATTEMPT_ID_MISSING');
    }
    expect(evidenceRefinements).not.toContain('!invocation.attemptId');
    expect(reviewTool).not.toMatch(/if\s*\(\s*!attemptId\s*\)/);
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
