/**
 * @module cli/install-ownership
 * @description Installer provenance that is deliberately separate from runtime FlowGuard config.
 */

import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import { z } from 'zod';
import { CliInstallError } from './errors.js';
import { InstallError } from './install-recovery.js';
import { parseJsonc } from './install-json.js';
import { isManagedArtifact, PLUGIN_RELATIVE_PATH, PLUGIN_WRAPPER } from './templates.js';
import {
  FLOWGUARD_INSTRUCTION_ENTRIES,
  OPENCODE_CONFIG_FILENAMES,
  type InstallPlatform,
  type InstallScope,
} from './install-types.js';

export const INSTALL_OWNERSHIP_FILENAME = '.flowguard-install-ownership.json';

const InstallOwnershipManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    platform: z.enum(['opencode', 'claude-code', 'codex']),
    scope: z.enum(['global', 'repo']),
    packageJson: z.object({
      created: z.boolean(),
      zodAdded: z.boolean(),
      previousCoreDependency: z.string().nullable(),
      installedCoreDependency: z.string().min(1),
    }),
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
  packageJsonCurrentContent?: string;
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

/** Reject obsolete FlowGuard installs, never migrate them or edit user config. */
export async function assertNoObsoleteOpenCodeInstallation(
  target: string,
  configDirectories: readonly string[],
): Promise<void> {
  for (const relative of ['tools/flowguard.ts', 'plugins/flowguard-audit.ts']) {
    if (await installationEntry(join(target, relative)))
      freshInstallRequired(join(target, relative));
  }
  const manifestPath = ownershipManifestPath(target);
  if (
    (await installationEntry(manifestPath)) &&
    (await readExistingManifestState(target)).kind !== 'valid'
  ) {
    freshInstallRequired(manifestPath);
  }
  for (const directory of new Set(configDirectories)) {
    for (const name of OPENCODE_CONFIG_FILENAMES) {
      await assertNoFlowGuardConfigRegistration(join(directory, name));
    }
  }
}

export async function assertNativeOpenCodeInstallTarget(
  target: string,
  configDirectories: readonly string[],
): Promise<void> {
  await assertNoObsoleteOpenCodeInstallation(target, configDirectories);
  const plugin = join(target, PLUGIN_RELATIVE_PATH);
  const entry = await installationEntry(plugin);
  if (
    entry &&
    (entry.isSymbolicLink() ||
      !entry.isFile() ||
      (await readFile(plugin, 'utf8')) !== PLUGIN_WRAPPER)
  ) {
    throw new InstallError(
      'MANAGED_ARTIFACT_CONFLICT',
      `${plugin} differs from the native FlowGuard plugin; preserve or archive it before a fresh installation. --force does not establish ownership.`,
    );
  }
}

/** lstat preserves dangling/symlink evidence instead of classifying it absent. */
async function installationEntry(file: string): Promise<Stats | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new InstallError(
      'INSTALL_OWNERSHIP_UNAVAILABLE',
      `Cannot inspect installation entry ${file}: ${String(error)}`,
    );
  }
}

async function assertNoFlowGuardConfigRegistration(file: string): Promise<void> {
  if (!(await installationEntry(file))) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new TypeError('Expected a config object');
  } catch (cause) {
    throw new InstallError(
      'OPENCODE_CONFIG_INVALID',
      `Cannot validate ${file}; preserve and repair the OpenCode config before installation: ${String(cause)}`,
    );
  }
  if (
    Array.isArray(parsed.instructions) &&
    parsed.instructions.some((entry) => FLOWGUARD_INSTRUCTION_ENTRIES.includes(entry))
  )
    freshInstallRequired(file);
  const configured = [parsed.plugins, parsed.plugin].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  if (configured.some(isFlowGuardRegistration)) freshInstallRequired(file);
}

/** Obsolete shapes are recognized only to reject them, never to load/migrate. */
function isFlowGuardRegistration(entry: unknown): boolean {
  const source = Array.isArray(entry)
    ? entry[0]
    : typeof entry === 'object' && entry !== null
      ? Reflect.get(entry, 'package')
      : entry;
  return (
    typeof source === 'string' &&
    (/^@flowguard\/core(?:@[^/]+)?(?:\/integration(?:\/plugin)?)?$/.test(source) ||
      /(?:^|\/)flowguard-audit(?:\.ts)?$/.test(source) ||
      /(?:^|\/)plugins\/flowguard(?:\/index\.ts)?\/?$/.test(source))
  );
}

function freshInstallRequired(path: string): never {
  throw new InstallError(
    'OPENCODE_FRESH_INSTALL_REQUIRED',
    `Obsolete or duplicate FlowGuard installation at ${path}. Archive the old installation and governance evidence without changing their bytes; remove only confirmed old FlowGuard registrations, then perform a fresh V2 install. --force cannot migrate old formats.`,
  );
}

function derivePackageOwnership(
  input: DeriveOwnershipInput,
): InstallOwnershipManifest['packageJson'] {
  const previousDeps = parsedDependencies(input.packageJsonOriginalContent);
  const created = !input.packageJsonExisted;
  const zodAdded = created || previousDeps === null || !('zod' in previousDeps);
  const core = previousDeps?.['@flowguard/core'];
  const currentDeps = input.packageJsonCurrentContent
    ? parsedDependencies(Buffer.from(input.packageJsonCurrentContent, 'utf-8'))
    : null;
  const installedCore = currentDeps?.['@flowguard/core'];
  if (typeof installedCore !== 'string' || installedCore.length === 0) {
    throw new InstallError(
      'INSTALL_OWNERSHIP_UNAVAILABLE',
      'INSTALL_OWNERSHIP_UNAVAILABLE: installed @flowguard/core dependency could not be captured for ownership provenance',
    );
  }
  return {
    created,
    zodAdded,
    previousCoreDependency: typeof core === 'string' ? core : null,
    installedCoreDependency: installedCore,
  };
}

export function deriveInstallOwnershipManifest(
  input: DeriveOwnershipInput,
): InstallOwnershipManifest {
  return InstallOwnershipManifestSchema.parse({
    schemaVersion: 2,
    platform: input.platform,
    scope: input.scope,
    packageJson: derivePackageOwnership(input),
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
    throw new CliInstallError(
      'OWNERSHIP_MANIFEST_INVALID',
      `${INSTALL_OWNERSHIP_FILENAME} exists but is not a valid FlowGuard ownership manifest; preserving it`,
    );
  }
  if (
    existing.kind === 'valid' &&
    (existing.manifest.platform !== manifest.platform || existing.manifest.scope !== manifest.scope)
  ) {
    throw new CliInstallError(
      'OWNERSHIP_MANIFEST_SCOPE_MISMATCH',
      `${INSTALL_OWNERSHIP_FILENAME} belongs to a different FlowGuard host/scope; preserving it`,
    );
  }

  const effective =
    existing.kind === 'valid'
      ? {
          ...existing.manifest,
          packageJson: {
            ...existing.manifest.packageJson,
            installedCoreDependency: manifest.packageJson.installedCoreDependency,
          },
        }
      : manifest;
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
