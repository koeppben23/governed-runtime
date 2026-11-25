/**
 * @module shared/safe-file-read
 * @description Bounded, type-checked reads for security-sensitive files.
 *
 * The helper pins one inode with `O_NOFOLLOW` where the platform exposes it,
 * rejects non-regular files before and after opening, and reads at most
 * `maxBytes + 1` bytes so growth after `fstat` cannot produce an unbounded
 * read. `O_NONBLOCK` prevents a FIFO/device open from blocking before the
 * type check on POSIX.
 *
 * Platform boundary: Node exposes no portable `unlinkat`-by-fd API. Callers
 * that delete the path after validation must re-check the pinned identity and
 * document the remaining path-replacement window instead of claiming atomic
 * removal.
 */

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export type SafeFileReadErrorCode =
  'NOT_REGULAR' | 'SYMLINK' | 'OVERSIZED' | 'MISSING' | 'CHANGED' | 'UNAVAILABLE';

export class SafeFileReadError extends Error {
  readonly code: SafeFileReadErrorCode;
  readonly bytes: number | null;

  constructor(code: SafeFileReadErrorCode, message: string, bytes: number | null = null) {
    super(message);
    this.name = 'SafeFileReadError';
    this.code = code;
    this.bytes = bytes;
  }
}

export interface SafeFileReadOptions {
  readonly maxBytes: number;
  readonly allowMissing?: boolean;
}

export interface SafeFileReadResult {
  readonly content: string;
  readonly raw: Buffer;
  readonly bytes: number;
  readonly identity: { readonly dev: number; readonly ino: number };
}

function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

async function classifyPath(filePath: string): Promise<'file' | 'missing'> {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (errno(error) === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new SafeFileReadError('SYMLINK', `Refusing symlink: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new SafeFileReadError('NOT_REGULAR', `Not a regular file: ${filePath}`);
  }
  return 'file';
}

async function openChecked(filePath: string): Promise<{
  readonly handle: FileHandle;
  readonly stat: Awaited<ReturnType<FileHandle['stat']>>;
}> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new SafeFileReadError('NOT_REGULAR', `Not a regular file: ${filePath}`);
    }
    const afterOpen = await lstat(filePath);
    if (afterOpen.isSymbolicLink() || afterOpen.dev !== stat.dev || afterOpen.ino !== stat.ino) {
      throw new SafeFileReadError('CHANGED', `File changed while opening: ${filePath}`);
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readBoundedBytes(handle: FileHandle, maxBytes: number, filePath: string) {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new SafeFileReadError(
      'OVERSIZED',
      `File exceeds the ${maxBytes}-byte limit: ${filePath}`,
      offset,
    );
  }
  return buffer.subarray(0, offset);
}

function normalizeReadError(
  error: unknown,
  filePath: string,
  allowMissing: boolean,
): SafeFileReadError | null {
  if (error instanceof SafeFileReadError) return error;
  if (errno(error) === 'ELOOP')
    return new SafeFileReadError('SYMLINK', `Refusing symlink: ${filePath}`);
  if (errno(error) === 'ENOENT') {
    return allowMissing ? null : new SafeFileReadError('MISSING', `Missing: ${filePath}`);
  }
  return new SafeFileReadError('UNAVAILABLE', `Cannot read ${filePath}`);
}

/**
 * Read a bounded regular file as UTF-8.
 *
 * Returns `null` only when `allowMissing` is set and the path does not exist.
 * Every other failure is a typed `SafeFileReadError`.
 */
export async function readRegularFileBounded(
  filePath: string,
  options: SafeFileReadOptions,
): Promise<SafeFileReadResult | null> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new SafeFileReadError('UNAVAILABLE', 'maxBytes must be a positive integer');
  }

  try {
    const pathState = await classifyPath(filePath);
    if (pathState === 'missing') {
      if (options.allowMissing === true) return null;
      throw new SafeFileReadError('MISSING', `Missing: ${filePath}`);
    }
    const opened = await openChecked(filePath);
    try {
      if (opened.stat.size > options.maxBytes) {
        throw new SafeFileReadError(
          'OVERSIZED',
          `File exceeds the ${options.maxBytes}-byte limit: ${filePath}`,
          Number(opened.stat.size),
        );
      }
      const bytes = await readBoundedBytes(opened.handle, options.maxBytes, filePath);
      return {
        content: bytes.toString('utf8'),
        raw: bytes,
        bytes: bytes.length,
        identity: { dev: Number(opened.stat.dev), ino: Number(opened.stat.ino) },
      };
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    const normalized = normalizeReadError(error, filePath, options.allowMissing === true);
    if (normalized === null) return null;
    throw normalized;
  }
}
