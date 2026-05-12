import { createHash } from 'node:crypto';

/** Hash a UTF-8 string and return full hex digest. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}
