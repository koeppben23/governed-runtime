import * as fs from 'node:fs/promises';

/**
 * Typed persistence error codes.
 * Compile-time validated — no arbitrary strings allowed.
 */
export type PersistenceErrorCode =
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'PARSE_FAILED'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'LEGACY_ASSURANCE_FORMAT_UNSUPPORTED'
  | 'LOCK_TIMEOUT'
  | 'LOCK_TIMEOUT_EXHAUSTED'
  | 'MISSING_FILE_DIGEST';

/**
 * Typed persistence error shared by adapter persistence modules.
 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

/** Ensure a directory exists. Idempotent. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Type-safe ENOENT check. Shared by persistence and git adapters. */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
