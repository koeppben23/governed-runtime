import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Hash a UTF-8 string and return full hex digest. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Hash a file (binary-safe) and return full hex digest. Streams for memory efficiency. */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
