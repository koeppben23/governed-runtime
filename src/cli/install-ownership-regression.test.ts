import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMandatesContent } from '../rendering/mandates-renderer.js';
import { computeMandatesDigest } from './install-helpers.js';
import { formatRecoveryLines } from './install-recovery.js';
import {
  assertManagedMandatesOwnership,
  assertNoAmbiguousLegacyInstruction,
  deriveInstallOwnershipManifest,
  readInstallOwnershipManifest,
  writeInstallOwnershipManifest,
} from './install-ownership.js';
import { removeFromOpencodeJson } from './install-json.js';

describe.sequential('installer ownership regressions', () => {
  it('blocks ambiguous historical AGENTS.md authority only for verified reinstalls', () => {
    const previous = Buffer.from(JSON.stringify({ instructions: ['AGENTS.md'] }));
    expect(() =>
      assertNoAmbiguousLegacyInstruction({
        platform: 'opencode',
        verifiedReinstall: false,
        opencodeOriginalContent: previous,
      }),
    ).not.toThrow();
    expect(() =>
      assertNoAmbiguousLegacyInstruction({
        platform: 'opencode',
        verifiedReinstall: true,
        opencodeOriginalContent: previous,
      }),
    ).toThrow(/LEGACY_INSTRUCTION_AMBIGUOUS/);
  });

  it('classifies unmanaged mandate conflicts with non-destructive recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-ownership-conflict-'));
    const path = join(dir, 'flowguard-mandates.md');
    try {
      writeFileSync(path, '# customer content\n');
      await expect(assertManagedMandatesOwnership(path)).rejects.toMatchObject({
        code: 'MANAGED_ARTIFACT_CONFLICT',
      });
      const recovery = formatRecoveryLines([
        { code: 'MANAGED_ARTIFACT_CONFLICT', message: 'conflict' },
      ]).join('\n');
      expect(recovery).toContain('Move or rename');
      expect(recovery).not.toContain('--force');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a managed mandate header as ownership evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-managed-mandate-'));
    const path = join(dir, 'flowguard-mandates.md');
    try {
      writeFileSync(path, buildMandatesContent('1.0.0', computeMandatesDigest()));
      await expect(assertManagedMandatesOwnership(path)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the customer dependency pre-state and task-hardening ownership', () => {
    const manifest = deriveInstallOwnershipManifest({
      platform: 'opencode',
      scope: 'repo',
      packageJsonExisted: true,
      packageJsonOriginalContent: Buffer.from(
        JSON.stringify({
          dependencies: { '@flowguard/core': 'workspace:*', zod: '^3.22.0' },
        }),
      ),
      opencodeOriginalContent: Buffer.from(JSON.stringify({ instructions: [] })),
      opencodeCurrentContent: JSON.stringify({
        instructions: ['.opencode/flowguard-mandates.md'],
        agent: { build: { permission: { task: { '*': 'deny', 'flowguard-reviewer': 'allow' } } } },
      }),
    });

    expect(manifest.packageJson).toEqual({
      created: false,
      zodAdded: false,
      previousCoreDependency: 'workspace:*',
    });
    expect(manifest.opencode?.taskHardeningAdded).toBe(true);
  });

  it('retains first-install provenance across force reinstalls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-ownership-chain-'));
    try {
      const first = deriveInstallOwnershipManifest({
        platform: 'opencode',
        scope: 'repo',
        packageJsonExisted: true,
        packageJsonOriginalContent: Buffer.from(JSON.stringify({ dependencies: { zod: '^3.22.0' } })),
        opencodeOriginalContent: Buffer.from(JSON.stringify({ instructions: [] })),
        opencodeCurrentContent: JSON.stringify({
          instructions: ['.opencode/flowguard-mandates.md'],
          agent: { build: { permission: { task: { '*': 'deny', 'flowguard-reviewer': 'allow' } } } },
        }),
      });
      await writeInstallOwnershipManifest(dir, first);

      const reinstall = deriveInstallOwnershipManifest({
        platform: 'opencode',
        scope: 'repo',
        packageJsonExisted: true,
        packageJsonOriginalContent: Buffer.from(
          JSON.stringify({ dependencies: { '@flowguard/core': 'file:./vendor/flowguard.tgz', zod: '^4.0.0' } }),
        ),
        opencodeOriginalContent: Buffer.from(
          JSON.stringify({
            instructions: ['.opencode/flowguard-mandates.md'],
            agent: { build: { permission: { task: { '*': 'deny', 'flowguard-reviewer': 'allow' } } } },
          }),
        ),
        opencodeCurrentContent: JSON.stringify({}),
      });
      await writeInstallOwnershipManifest(dir, reinstall);

      await expect(readInstallOwnershipManifest(dir)).resolves.toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes the FlowGuard instruction but preserves customer task permissions without provenance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-task-preserve-'));
    const path = join(dir, 'opencode.json');
    try {
      const task = { '*': 'allow', 'flowguard-reviewer': 'allow', 'customer-agent': 'ask' };
      writeFileSync(
        path,
        JSON.stringify({
          instructions: ['.opencode/flowguard-mandates.md'],
          agent: { build: { permission: { task } } },
        }),
      );
      await removeFromOpencodeJson(path, 'repo');
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.instructions).toEqual([]);
      expect(parsed.agent.build.permission.task).toEqual(task);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes only provenance-owned task hardening and preserves foreign entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-task-owned-'));
    const path = join(dir, 'opencode.json');
    try {
      writeFileSync(
        path,
        JSON.stringify({
          instructions: ['.opencode/flowguard-mandates.md'],
          agent: {
            build: {
              permission: {
                task: { '*': 'deny', 'flowguard-reviewer': 'allow', 'customer-agent': 'ask' },
              },
            },
          },
        }),
      );
      await removeFromOpencodeJson(path, 'repo', { removeManagedTaskHardening: true });
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      expect(parsed.agent.build.permission.task).toEqual({ 'customer-agent': 'ask' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
