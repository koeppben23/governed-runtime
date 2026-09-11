/**
 * @module cli/install-ownership
 * @description Installer provenance that is deliberately separate from runtime FlowGuard config.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { InstallPlatform, InstallScope } from './install-types.js';

export const INSTALL_OWNERSHIP_FILENAME = '.flowguard-install-ownership.json';

const InstallOwnershipManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.enum(['opencode', 'claude-code', 'codex']),
    scope: z.enum(['global', 'repo']),
    packageJson: z.object({
      created: z.boolean(),
      zodAdded: z.boolean(),
    }),
    opencode: z
      .object({
        taskHardeningAdded: z.boolean(),
        legacyInstructionMigrated: z.boolean(),
      })
      .optional(),
  })
  .strict();

export type InstallOwnershipManifest = z.infer<typeof InstallOwnershipManifestSchema>;

export function ownershipManifestPath(target: string): string {
  return join(target, INSTALL_OWNERSHIP_FILENAME);
}

export function createInstallOwnershipManifest(input: {
  platform: InstallPlatform;
  scope: InstallScope;
  packageJsonCreated: boolean;
  zodAdded: boolean;
  taskHardeningAdded?: boolean;
  legacyInstructionMigrated?: boolean;
}): InstallOwnershipManifest {
  return InstallOwnershipManifestSchema.parse({
    schemaVersion: 1,
    platform: input.platform,
    scope: input.scope,
    packageJson: {
      created: input.packageJsonCreated,
      zodAdded: input.zodAdded,
    },
    ...(input.platform === 'opencode'
      ? {
          opencode: {
            taskHardeningAdded: input.taskHardeningAdded ?? false,
            legacyInstructionMigrated: input.legacyInstructionMigrated ?? false,
          },
        }
      : {}),
  });
}

export async function writeInstallOwnershipManifest(
  target: string,
  manifest: InstallOwnershipManifest,
): Promise<string> {
  const path = ownershipManifestPath(target);
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
    await rename(tmp, path);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      // best-effort cleanup; original error wins
    }
    throw error;
  }
  return path;
}

export async function readInstallOwnershipManifest(
  target: string,
): Promise<InstallOwnershipManifest | null> {
  try {
    const raw = await readFile(ownershipManifestPath(target), 'utf-8');
    const parsed = InstallOwnershipManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    return null;
  }
}
