/**
 * @module cli/install-ownership
 * @description Installer provenance that is deliberately separate from runtime FlowGuard config.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { InstallError } from './install-recovery.js';
import { parseJsonc } from './install-json.js';
import { isManagedArtifact } from './templates.js';
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
      previousCoreDependency: z.string().nullable(),
    }),
    opencode: z
      .object({
        taskHardeningAdded: z.boolean(),
      })
      .optional(),
  })
  .strict();

export type InstallOwnershipManifest = z.infer<typeof InstallOwnershipManifestSchema>;

type ExistingManifestState =
  { kind: 'absent' } | { kind: 'valid'; manifest: InstallOwnershipManifest } | { kind: 'invalid' };

interface DeriveOwnershipInput {
  platform: InstallPlatform;
  scope: InstallScope;
  packageJsonExisted: boolean;
  packageJsonOriginalContent?: Buffer;
  opencodeOriginalContent?: Buffer;
  opencodeCurrentContent?: string | null;
}

export function ownershipManifestPath(target: string): string {
  return join(target, INSTALL_OWNERSHIP_FILENAME);
}

export async function assertManagedMandatesOwnership(path: string): Promise<void> {
  try {
    const existing = await readFile(path, 'utf-8');
    if (!isManagedArtifact(existing)) {
      throw new InstallError(
        'MANAGED_ARTIFACT_CONFLICT',
        `MANAGED_ARTIFACT_CONFLICT: ${path} exists but is not a FlowGuard-managed artifact; refusing to overwrite customer-owned content`,
      );
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

function parsedDependencies(content: Buffer | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content.toString('utf-8')) as Record<string, unknown>;
    const dependencies = parsed['dependencies'];
    return dependencies && typeof dependencies === 'object'
      ? (dependencies as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }
}

function parsedOpencode(content: Buffer | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    return parseJsonc<Record<string, unknown>>(content.toString('utf-8'));
  } catch {
    return null;
  }
}

function taskPermissions(parsed: Record<string, unknown> | null): Record<string, unknown> | null {
  const agent = parsed?.['agent'];
  if (!agent || typeof agent !== 'object') return null;
  const build = (agent as Record<string, unknown>)['build'];
  if (!build || typeof build !== 'object') return null;
  const permission = (build as Record<string, unknown>)['permission'];
  if (!permission || typeof permission !== 'object') return null;
  const task = (permission as Record<string, unknown>)['task'];
  return task && typeof task === 'object' ? (task as Record<string, unknown>) : null;
}

function instructions(parsed: Record<string, unknown> | null): string[] {
  const value = parsed?.['instructions'];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Historical FlowGuard versions referenced AGENTS.md but did not own/create that file.
 * Therefore a reinstall cannot safely infer whether the entry is legacy FlowGuard or
 * customer authority. Fail before any mutation instead of deleting ambiguous content.
 */
export function assertNoAmbiguousLegacyInstruction(input: {
  platform: InstallPlatform;
  verifiedReinstall: boolean;
  opencodeOriginalContent?: Buffer;
}): void {
  if (input.platform !== 'opencode' || !input.verifiedReinstall) return;
  const previous = parsedOpencode(input.opencodeOriginalContent);
  if (!instructions(previous).includes('AGENTS.md')) return;
  throw new InstallError(
    'LEGACY_INSTRUCTION_AMBIGUOUS',
    'LEGACY_INSTRUCTION_AMBIGUOUS: existing OpenCode instructions include AGENTS.md from a historical FlowGuard-era configuration, but FlowGuard cannot prove ownership of that file. Remove only the obsolete FlowGuard reference after confirming AGENTS.md is not customer authority, then rerun install.',
  );
}

function derivePackageOwnership(
  input: DeriveOwnershipInput,
): InstallOwnershipManifest['packageJson'] {
  const previousDeps = parsedDependencies(input.packageJsonOriginalContent);
  const created = !input.packageJsonExisted;
  const zodAdded = created || previousDeps === null || !('zod' in previousDeps);
  const core = previousDeps?.['@flowguard/core'];
  return {
    created,
    zodAdded,
    previousCoreDependency: typeof core === 'string' ? core : null,
  };
}

function deriveTaskHardeningOwnership(input: DeriveOwnershipInput): boolean {
  if (input.platform !== 'opencode') return false;
  const previousTask = taskPermissions(parsedOpencode(input.opencodeOriginalContent));
  const currentOpencode = input.opencodeCurrentContent
    ? parseJsonc<Record<string, unknown>>(input.opencodeCurrentContent)
    : null;
  const currentTask = taskPermissions(currentOpencode);
  return (
    previousTask === null &&
    currentTask?.['*'] === 'deny' &&
    currentTask?.[REVIEWER_SUBAGENT_TYPE] === 'allow'
  );
}

export function deriveInstallOwnershipManifest(
  input: DeriveOwnershipInput,
): InstallOwnershipManifest {
  return InstallOwnershipManifestSchema.parse({
    schemaVersion: 1,
    platform: input.platform,
    scope: input.scope,
    packageJson: derivePackageOwnership(input),
    ...(input.platform === 'opencode'
      ? { opencode: { taskHardeningAdded: deriveTaskHardeningOwnership(input) } }
      : {}),
  });
}

async function readExistingManifestState(target: string): Promise<ExistingManifestState> {
  try {
    const raw = await readFile(ownershipManifestPath(target), 'utf-8');
    try {
      const parsed = InstallOwnershipManifestSchema.safeParse(JSON.parse(raw));
      return parsed.success ? { kind: 'valid', manifest: parsed.data } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'invalid' };
  }
}

export async function writeInstallOwnershipManifest(
  target: string,
  manifest: InstallOwnershipManifest,
): Promise<string> {
  const path = ownershipManifestPath(target);
  const existing = await readExistingManifestState(target);
  if (existing.kind === 'invalid') {
    throw new Error(
      `${INSTALL_OWNERSHIP_FILENAME} exists but is not a valid FlowGuard ownership manifest; preserving it`,
    );
  }
  if (
    existing.kind === 'valid' &&
    (existing.manifest.platform !== manifest.platform || existing.manifest.scope !== manifest.scope)
  ) {
    throw new Error(
      `${INSTALL_OWNERSHIP_FILENAME} belongs to a different FlowGuard host/scope; preserving it`,
    );
  }

  const effective = existing.kind === 'valid' ? existing.manifest : manifest;
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(effective, null, 2) + '\n', {
      encoding: 'utf-8',
      flag: 'wx',
    });
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
  const state = await readExistingManifestState(target);
  return state.kind === 'valid' ? state.manifest : null;
}
