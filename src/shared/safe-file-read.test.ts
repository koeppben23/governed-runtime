import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFileReadError, readRegularFileBounded } from './safe-file-read.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'fg-safe-read-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('safe-file-read', () => {
  it('reads a regular file within the byte bound and returns its identity', async () => {
    const file = join(root(), 'value.txt');
    writeFileSync(file, 'hello');
    const result = await readRegularFileBounded(file, { maxBytes: 16 });
    expect(result).toMatchObject({ content: 'hello', bytes: 5 });
    expect(result?.identity.ino).toBeGreaterThan(0);
  });

  it('rejects a regular file above the limit before and during the read', async () => {
    const file = join(root(), 'large.txt');
    writeFileSync(file, 'x'.repeat(17));
    await expect(readRegularFileBounded(file, { maxBytes: 16 })).rejects.toMatchObject({
      code: 'OVERSIZED',
      bytes: 17,
    });
  });

  it('treats a missing file as absence only when explicitly allowed', async () => {
    const file = join(root(), 'missing.txt');
    await expect(
      readRegularFileBounded(file, { maxBytes: 16, allowMissing: true }),
    ).resolves.toBeNull();
    await expect(readRegularFileBounded(file, { maxBytes: 16 })).rejects.toBeInstanceOf(
      SafeFileReadError,
    );
  });

  it('rejects directories and symlinks', async () => {
    const dir = root();
    await expect(readRegularFileBounded(dir, { maxBytes: 16 })).rejects.toMatchObject({
      code: 'NOT_REGULAR',
    });
    if (process.platform !== 'win32') {
      const target = join(dir, 'target.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(target, 'secret');
      symlinkSync(target, link);
      await expect(readRegularFileBounded(link, { maxBytes: 16 })).rejects.toMatchObject({
        code: 'SYMLINK',
      });
    }
  });

  it('does not block on a FIFO without a writer', async () => {
    if (process.platform === 'win32') return;
    const file = join(root(), 'fifo');
    execFileSync('mkfifo', [file]);
    await expect(readRegularFileBounded(file, { maxBytes: 16 })).rejects.toMatchObject({
      code: 'NOT_REGULAR',
    });
  });

  it('rejects an invalid byte bound', async () => {
    await expect(readRegularFileBounded(join(root(), 'x'), { maxBytes: 0 })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('rejects a directory created between the path and handle checks', async () => {
    const file = join(root(), 'swapped');
    mkdirSync(file);
    await expect(readRegularFileBounded(file, { maxBytes: 16 })).rejects.toMatchObject({
      code: 'NOT_REGULAR',
    });
  });
});
