import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('developer onboarding documentation contract', () => {
  it('links both developer walkthroughs from the documentation index', () => {
    const index = read('docs/index.md');

    expect(index).toContain('./development/first-change.md');
    expect(index).toContain('./development/state-changing-operation.md');
  });

  it('uses the canonical peer-review terminal phase in the quick reference', () => {
    const index = read('docs/index.md');
    const quickReference = index.split('## Quick Reference')[1] ?? '';

    expect(quickReference).toContain('PEER_REVIEW_COMPLETE');
    expect(quickReference).not.toMatch(/(?<![A-Z_])REVIEW_COMPLETE(?![A-Z_])/);
  });

  it('points contributors to the canonical CI and branch-protection sources', () => {
    const contributing = read('CONTRIBUTING.md');
    const ciSection = contributing.split('### CI Status Checks')[1]?.split('\n## ')[0] ?? '';

    expect(ciSection).toContain('.github/BRANCH-PROTECTION.md');
    expect(ciSection).toContain('.github/workflows/ci.yml');
    expect(ciSection).not.toContain('needs: [unit, integration]');
  });

  it('documents the separate approval, export, regulated completion, and recovery stages', () => {
    const guide = read('docs/development/state-changing-operation.md');

    for (const path of [
      'decision-tool.ts',
      'export-tool.ts',
      'rails/export.ts',
      'regulated-completion.ts',
      'regulated-completion-decision.ts',
      'plugin-regulated-recovery.ts',
      'regulated-completion.test.ts',
      'plugin-regulated-recovery.test.ts',
      'helpers.ts',
      'audit-outbox.ts',
      'plugin-audit-reconcile.ts',
      'write-state-with-artifacts.test.ts',
    ]) {
      expect(guide).toContain(path);
    }
    for (const functionName of [
      'persistAndFormat',
      'writeStateWithArtifactsAndAuditOperations',
      'prepareStateWithAuditOperations',
      'writeStateWithArtifactsAlreadyLocked',
    ]) {
      expect(guide).toContain(functionName);
    }
    expect(guide).toContain('EXPORT_READY');
    expect(guide).toContain('COMPLETE');
    expect(guide).toContain('approval transition and its associated decision receipt');
    expect(guide).toContain(
      'the export transition and then the `session_completed` lifecycle event',
    );
  });
});
