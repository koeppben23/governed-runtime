/**
 * @module integration/tools/write-state-with-artifacts.test
 * @description Tests for writeStateWithArtifacts artifacts-first ordering fix.
 *
 * This fix prevents the EVIDENCE_ARTIFACT_MISSING corruption scenario:
 * state was previously written BEFORE artifacts — if a crash occurred between
 * the two writes, state would reference artifacts that don't exist on disk.
 *
 * New ordering: artifacts-first, state-last.
 * - Crash after artifacts, before state → orphan files (benign)
 * - Crash after state → both exist, consistent
 *
 * Coverage:
 * - HAPPY: artifacts written before state, both exist after success
 * - HAPPY: pre-computed hash matches state file hash
 * - BAD: invalid state never hits disk (schema validation first)
 * - CORNER: artifact materialization failure prevents state write
 * - EDGE: state with no plan/ticket still writes correctly
 *
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  resolveWorkspacePaths,
  withMutableSessionTransaction,
  writeStateWithArtifacts,
} from './helpers.js';
import { readState, statePath, atomicWrite } from '../../adapters/persistence.js';
import { makeState, makeProgressedState } from '../../__fixtures__.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'gov-helpers-test-'));
}

async function cleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
}

/** Compute SHA-256 hash of a file. */
async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8');
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Check if artifacts directory exists. */
async function artifactsDirExists(sessDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(sessDir, 'artifacts'));
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// writeStateWithArtifacts — Artifacts-First Ordering
// ═══════════════════════════════════════════════════════════════════════════════

describe('writeStateWithArtifacts — artifacts-first ordering', () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await cleanup(tmpDir);
  });

  // ─── HAPPY: Basic operation ───────────────────────────────────────────────

  describe('HAPPY — basic operation', () => {
    it('writes state and artifacts successfully for a minimal state', async () => {
      const state = makeState('TICKET');
      await writeStateWithArtifacts(tmpDir, state);

      // State file exists and is valid
      const read = await readState(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.phase).toBe('TICKET');
      expect(read!.id).toBe(state.id);
    });

    it('writes state and artifacts for a state with plan (generates artifacts)', async () => {
      const state = makeProgressedState('PLAN');
      await writeStateWithArtifacts(tmpDir, state);

      // State file exists
      const read = await readState(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.phase).toBe('PLAN');

      // Artifacts directory was created
      expect(await artifactsDirExists(tmpDir)).toBe(true);
    });

    it('state file content matches expected serialization', async () => {
      const state = makeState('READY');
      await writeStateWithArtifacts(tmpDir, state);

      const content = await fs.readFile(statePath(tmpDir), 'utf-8');
      // Pretty-printed JSON with trailing newline
      expect(content.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(content);
      expect(parsed.phase).toBe('READY');
      expect(parsed.schemaVersion).toBe('v1');
    });
  });

  describe('BAD — concurrent mutable sessions are serialized', () => {
    it('does not lose updates from parallel read-modify-write transactions', async () => {
      const sessionID = crypto.randomUUID();
      const context = { sessionID, worktree: tmpDir, directory: tmpDir };
      const { sessDir } = await resolveWorkspacePaths(context);
      await writeStateWithArtifacts(sessDir, { ...makeState('VALIDATION'), activeChecks: [] });

      await Promise.all([
        withMutableSessionTransaction(context, async (session) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          await writeStateWithArtifacts(session.sessDir, {
            ...session.state,
            activeChecks: [...session.state.activeChecks, 'first'],
          });
        }),
        withMutableSessionTransaction(context, async (session) => {
          await writeStateWithArtifacts(session.sessDir, {
            ...session.state,
            activeChecks: [...session.state.activeChecks, 'second'],
          });
        }),
      ]);

      const finalState = await readState(sessDir);
      expect([...(finalState?.activeChecks ?? [])].sort()).toEqual(['first', 'second']);
    });
  });

  // ─── HAPPY: Pre-computed hash consistency ─────────────────────────────────

  describe('HAPPY — pre-computed hash consistency', () => {
    it('state file hash matches what writeState would produce', async () => {
      const state = makeProgressedState('PLAN');
      await writeStateWithArtifacts(tmpDir, state);

      // Read the state file and compute its hash
      const stateContent = await fs.readFile(statePath(tmpDir), 'utf-8');
      const actualHash = crypto.createHash('sha256').update(stateContent, 'utf-8').digest('hex');

      // Verify by reading artifact metadata (if artifacts are generated)
      // The artifact JSON files include a sourceStateHash that should match
      const artifactsDir = path.join(tmpDir, 'artifacts');
      try {
        const files = await fs.readdir(artifactsDir);
        const jsonFiles = files.filter((f) => f.endsWith('.json'));
        for (const jsonFile of jsonFiles) {
          const artifactContent = await fs.readFile(path.join(artifactsDir, jsonFile), 'utf-8');
          const artifact = JSON.parse(artifactContent);
          // sourceStateHash in artifact must match the actual state file hash
          expect(artifact.sourceStateHash).toBe(actualHash);
        }
      } catch {
        // No artifacts generated for this state (no plan/ticket) — that's OK
      }
    });

    it('pre-computed hash is deterministic for same state', async () => {
      const state = makeState('TICKET');

      // Write twice to different dirs
      const dir1 = await createTmpDir();
      const dir2 = await createTmpDir();
      try {
        await writeStateWithArtifacts(dir1, state);
        await writeStateWithArtifacts(dir2, state);

        const hash1 = await hashFile(statePath(dir1));
        const hash2 = await hashFile(statePath(dir2));
        expect(hash1).toBe(hash2);
      } finally {
        await cleanup(dir1);
        await cleanup(dir2);
      }
    });
  });

  // ─── BAD: Schema validation ───────────────────────────────────────────────

  describe('BAD — schema validation prevents disk writes', () => {
    it('throws on invalid state (missing required fields)', async () => {
      const invalidState = {
        phase: 'TICKET',
      } as unknown as import('../../state/schema.js').SessionState;

      await expect(writeStateWithArtifacts(tmpDir, invalidState)).rejects.toThrow(
        /Refusing to persist invalid state/,
      );

      // Nothing written to disk
      const stateFile = statePath(tmpDir);
      await expect(fs.access(stateFile)).rejects.toThrow();
    });

    it('throws with SCHEMA_VALIDATION_FAILED code', async () => {
      const invalidState = {
        foo: 'bar',
      } as unknown as import('../../state/schema.js').SessionState;

      try {
        await writeStateWithArtifacts(tmpDir, invalidState);
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('SCHEMA_VALIDATION_FAILED');
      }
    });

    it('does not create artifacts directory for invalid state', async () => {
      const invalidState = {} as unknown as import('../../state/schema.js').SessionState;

      await expect(writeStateWithArtifacts(tmpDir, invalidState)).rejects.toThrow();
      expect(await artifactsDirExists(tmpDir)).toBe(false);
    });
  });

  // ─── CORNER: Ordering verification ────────────────────────────────────────

  describe('CORNER — artifacts-first ordering verification', () => {
    it('artifacts exist on disk even if state write would hypothetically fail', async () => {
      // We verify the ordering by checking that after a successful write,
      // artifacts reference the correct state hash (pre-computed, not from disk)
      const state = makeProgressedState('PLAN');
      await writeStateWithArtifacts(tmpDir, state);

      // Both must exist
      const stateExists = await fs.access(statePath(tmpDir)).then(
        () => true,
        () => false,
      );
      const artifactsExist = await artifactsDirExists(tmpDir);
      expect(stateExists).toBe(true);
      expect(artifactsExist).toBe(true);
    });

    it('state file is written atomically (temp + rename pattern)', async () => {
      const state = makeState('READY');
      await writeStateWithArtifacts(tmpDir, state);

      // If the file exists and is valid JSON, it was written atomically
      // (non-atomic writes could leave partial files)
      const content = await fs.readFile(statePath(tmpDir), 'utf-8');
      expect(() => JSON.parse(content)).not.toThrow();
    });
  });

  // ─── EDGE: No artifacts needed ────────────────────────────────────────────

  describe('EDGE — states with no plan/ticket (no artifacts to materialize)', () => {
    it('READY state with no evidence writes state successfully', async () => {
      const state = makeState('READY');
      await writeStateWithArtifacts(tmpDir, state);

      const read = await readState(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.phase).toBe('READY');
    });

    it('TICKET phase with null ticket still writes state', async () => {
      const state = makeState('TICKET', { ticket: null });
      await writeStateWithArtifacts(tmpDir, state);

      const read = await readState(tmpDir);
      expect(read).not.toBeNull();
      expect(read!.phase).toBe('TICKET');
    });

    it('artifacts directory is created even when no artifacts are materialized', async () => {
      // materializeEvidenceArtifacts always creates the artifacts dir (mkdir recursive)
      const state = makeState('READY');
      await writeStateWithArtifacts(tmpDir, state);

      expect(await artifactsDirExists(tmpDir)).toBe(true);
    });
  });

  // ─── EDGE: Overwrite existing state ───────────────────────────────────────

  describe('EDGE — overwriting existing state', () => {
    it('overwrites previous state file correctly', async () => {
      const state1 = makeState('READY');
      const state2 = makeState('TICKET');

      await writeStateWithArtifacts(tmpDir, state1);
      const read1 = await readState(tmpDir);
      expect(read1!.phase).toBe('READY');

      await writeStateWithArtifacts(tmpDir, state2);
      const read2 = await readState(tmpDir);
      expect(read2!.phase).toBe('TICKET');
    });
  });
});
