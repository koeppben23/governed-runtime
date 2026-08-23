/**
 * @module workspace/archive-tar
 * @description Tar-member inspection shared by archive creation and verification.
 */

import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ArchiveTarInspection =
  { readonly kind: 'ok' } | { readonly kind: 'blocked'; readonly reason: string };

export async function inspectArchiveTar(
  archivePath: string,
  sessionId: string,
  expectedMembers?: readonly string[],
): Promise<ArchiveTarInspection> {
  const tar = promisify(execFile);
  let names: string;
  let details: string;
  try {
    [{ stdout: names }, { stdout: details }] = await Promise.all([
      tar('tar', ['-tzf', archivePath], { timeout: 30_000, windowsHide: true }),
      tar('tar', ['-tvzf', archivePath], { timeout: 30_000, windowsHide: true }),
    ]);
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `cannot inspect archive members: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const actualMembers = names.split(/\r?\n/).filter(Boolean);
  if (new Set(actualMembers).size !== actualMembers.length) {
    return { kind: 'blocked', reason: 'archive contains duplicate members' };
  }
  if (expectedMembers) {
    if (
      actualMembers.length !== expectedMembers.length ||
      actualMembers.some((member, index) => member !== expectedMembers[index])
    ) {
      return { kind: 'blocked', reason: 'archive contains undeclared or missing members' };
    }
  } else if (actualMembers.some((member) => !isSafeTarMemberPath(member, sessionId))) {
    return { kind: 'blocked', reason: 'archive contains an unsafe member path' };
  }

  const memberDetails = details.split(/\r?\n/).filter(Boolean);
  if (
    memberDetails.length !== actualMembers.length ||
    memberDetails.some((detail) => !detail.startsWith('-'))
  ) {
    return { kind: 'blocked', reason: 'archive contains a non-regular member' };
  }
  return { kind: 'ok' };
}

function isSafeTarMemberPath(member: string, sessionId: string): boolean {
  const prefix = `${sessionId}/`;
  if (!member.startsWith(prefix)) return false;
  const relativePath = member.slice(prefix.length);
  return (
    relativePath.length > 0 &&
    !path.posix.isAbsolute(relativePath) &&
    !relativePath.includes('\\') &&
    !relativePath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  );
}
