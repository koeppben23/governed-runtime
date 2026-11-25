/** JSONC parsing and package dependency updates. Native plugin discovery does
 * not require writing the user's OpenCode configuration. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as jsoncParse, type ParseError } from 'jsonc-parser';
import { ensureDir } from '../adapters/persistence.js';
import { FlowGuardConfigSchema } from '../config/flowguard-config.js';
import { getAdapterLogger } from '../logging/adapter-logger.js';
import { CliInstallError } from './errors.js';
import type { FileOp } from './install-types.js';
import { PACKAGE_JSON_TEMPLATE } from './templates.js';

export function parseJsonc<T = Record<string, unknown>>(content: string): T {
  const errors: ParseError[] = [];
  const result = jsoncParse(content, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first !== undefined) {
    throw new SyntaxError(`JSONC parse error at offset ${first.offset}: error code ${first.error}`);
  }
  return result as T;
}

/** Validate the exact FlowGuard file being merged, preserving tolerated keys. */
export function parseExistingFlowGuardConfig(
  raw: string,
  sourcePath: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliInstallError(
      'NON_OPENCODE_CONFIG_INVALID',
      `Existing FlowGuard config at ${sourcePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = FlowGuardConfigSchema.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const detail = issue
      ? `${issue.path.join('.') || '<root>'}: ${issue.message}`
      : 'unknown shape';
    throw new CliInstallError(
      'NON_OPENCODE_CONFIG_INVALID',
      `Existing FlowGuard config at ${sourcePath} is not a valid FlowGuard configuration (${detail}).`,
    );
  }
  return parsed as Record<string, unknown>;
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT')
      return null;
    throw err;
  }
}

export async function createMalformedJsonBackup(
  filePath: string,
  originalContent: string,
  now = new Date(),
): Promise<string> {
  const timestamp = now.toISOString().replace(/[-:.]/g, '');
  const backupPath = `${filePath}.flowguard-backup-${timestamp}`;
  await writeFile(backupPath, originalContent, { encoding: 'utf-8', flag: 'wx' });
  return backupPath;
}

export function vendorDependency(version: string): string {
  return `file:./vendor/flowguard-core-${version}.tgz`;
}

export async function mergePackageJson(filePath: string, version: string): Promise<FileOp> {
  const existing = await safeRead(filePath);
  if (!existing) {
    await ensureDir(dirname(filePath));
    await writeFile(filePath, PACKAGE_JSON_TEMPLATE(version), 'utf-8');
    return { path: filePath, action: 'written' };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    const backupPath = await createMalformedJsonBackup(filePath, existing);
    getAdapterLogger().warn('cli', 'Package.json malformed, creating backup and overwriting', {
      filePath,
      backupPath,
    });
    await writeFile(filePath, PACKAGE_JSON_TEMPLATE(version), 'utf-8');
    return {
      path: filePath,
      action: 'written',
      reason: `existing file was malformed JSON (backup: ${backupPath})`,
    };
  }
  const deps = (parsed['dependencies'] ?? {}) as Record<string, string>;
  deps['@flowguard/core'] = vendorDependency(version);
  if (!deps['zod']) deps['zod'] = '^4.0.0';
  parsed['dependencies'] = deps;
  await writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  return { path: filePath, action: 'merged' };
}
