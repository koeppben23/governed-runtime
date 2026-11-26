/**
 * @module adapters/persistence-atomic-write-phases.test
 * @description Deterministic publication-phase seam used by the SIGKILL matrix.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { durableAtomicWrite } from './persistence.js';
import {
  durableAtomicCloneAppend,
  resetCloneCapabilityCacheForTests,
} from './persistence-audit-clone.js';

const CHANNEL = 'flowguard.persistence.atomic-write';
let dir: string;

beforeEach(async () => {
  resetCloneCapabilityCacheForTests();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-write-phases-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('durable write phase seam', () => {
  it('publishes the durable rewrite phases in fsync/rename order', async () => {
    const phases: string[] = [];
    const subscriber = (message: unknown): void => {
      phases.push((message as { readonly phase: string }).phase);
    };
    subscribe(CHANNEL, subscriber);
    try {
      const filePath = path.join(dir, 'value.txt');
      await durableAtomicWrite(filePath, 'payload');
      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('payload');
    } finally {
      unsubscribe(CHANNEL, subscriber);
    }
    expect(phases).toEqual([
      'temp-opened',
      'temp-written',
      'temp-fsynced',
      'renamed',
      'dir-fsynced',
    ]);
  });

  it('publishes either clone phases or the explicit fallback phase', async () => {
    const filePath = path.join(dir, 'audit.jsonl');
    await fs.writeFile(filePath, 'first\n', 'utf8');
    const line = `second-${randomUUID()}\n`;
    const phases: string[] = [];
    const subscriber = (message: unknown): void => {
      phases.push((message as { readonly phase: string }).phase);
    };
    subscribe(CHANNEL, subscriber);
    try {
      await durableAtomicCloneAppend(filePath, line, 'first\nsecond\n');
    } finally {
      unsubscribe(CHANNEL, subscriber);
    }
    const clonePath = phases.includes('clone-created');
    expect(clonePath || phases.includes('clone-unsupported')).toBe(true);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(
      clonePath ? `first\n${line}` : 'first\nsecond\n',
    );
    expect(phases).toContain('renamed');
    expect(phases).toContain('dir-fsynced');
  });
});
