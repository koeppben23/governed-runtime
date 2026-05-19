/**
 * @module persistence-discovery
 * @description Discovery result and profile resolution persistence.
 *
 * Manages workspace-level discovery artifacts and per-session immutable
 * snapshots. Schema-validated before every write.
 *
 * @version v1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import {
  DiscoveryResultSchema,
  ProfileResolutionSchema,
  type DiscoveryResult,
  type ProfileResolution,
} from '../discovery/types.js';
import { ensureDir, atomicWrite, PersistenceError, isEnoent } from './persistence.js';

/**
 * Write a DiscoveryResult to {workspaceDir}/discovery/discovery.json.
 *
 * Schema-validated before write (fail-closed).
 * Atomic write for consistency.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 * @param result - The DiscoveryResult to persist.
 */
export async function writeDiscovery(workspaceDir: string, result: DiscoveryResult): Promise<void> {
  const parsed = DiscoveryResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `DiscoveryResult failed schema validation: ${parsed.error.message}`,
    );
  }
  const dir = path.join(workspaceDir, 'discovery');
  await ensureDir(dir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(dir, 'discovery.json'), json);
}

/**
 * Read a DiscoveryResult from {workspaceDir}/discovery/discovery.json.
 *
 * Returns null if the file does not exist.
 * Schema-validated on read (fail-closed on corruption).
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 */
export async function readDiscovery(workspaceDir: string): Promise<DiscoveryResult | null> {
  const filePath = path.join(workspaceDir, 'discovery', 'discovery.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    getAdapterLogger().error('persistence-discovery', 'Failed to read discovery file', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PersistenceError(
      'READ_FAILED',
      `Failed to read discovery file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PersistenceError('PARSE_FAILED', `Discovery file is not valid JSON`);
  }

  const parsed = DiscoveryResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Discovery file failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Write a ProfileResolution to {workspaceDir}/discovery/profile-resolution.json.
 *
 * Schema-validated before write. Atomic write.
 *
 * @param workspaceDir - Absolute path to the workspace directory.
 * @param resolution - The ProfileResolution to persist.
 */
export async function writeProfileResolution(
  workspaceDir: string,
  resolution: ProfileResolution,
): Promise<void> {
  const parsed = ProfileResolutionSchema.safeParse(resolution);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `ProfileResolution failed schema validation: ${parsed.error.message}`,
    );
  }
  const dir = path.join(workspaceDir, 'discovery');
  await ensureDir(dir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(dir, 'profile-resolution.json'), json);
}

/**
 * Write a discovery snapshot to {sessionDir}/discovery-snapshot.json.
 *
 * Immutable per-session copy. Schema-validated before write.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param result - The DiscoveryResult to snapshot.
 */
export async function writeDiscoverySnapshot(
  sessionDir: string,
  result: DiscoveryResult,
): Promise<void> {
  const parsed = DiscoveryResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Discovery snapshot failed schema validation: ${parsed.error.message}`,
    );
  }
  await ensureDir(sessionDir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(sessionDir, 'discovery-snapshot.json'), json);
}

/**
 * Write a profile-resolution snapshot to {sessionDir}/profile-resolution-snapshot.json.
 *
 * Immutable per-session copy. Schema-validated before write.
 *
 * @param sessionDir - Absolute path to the session directory.
 * @param resolution - The ProfileResolution to snapshot.
 */
export async function writeProfileResolutionSnapshot(
  sessionDir: string,
  resolution: ProfileResolution,
): Promise<void> {
  const parsed = ProfileResolutionSchema.safeParse(resolution);
  if (!parsed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Profile resolution snapshot failed schema validation: ${parsed.error.message}`,
    );
  }
  await ensureDir(sessionDir);
  const json = JSON.stringify(parsed.data, null, 2) + '\n';
  await atomicWrite(path.join(sessionDir, 'profile-resolution-snapshot.json'), json);
}
