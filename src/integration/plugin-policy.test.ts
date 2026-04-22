/**
 * @module integration/plugin-policy.test
 * @description Tests for P32: resolvePluginSessionPolicy function.
 *
 * Tests the extracted plugin policy resolver that implements:
 * Priority: state > config > solo
 *
 * Cases:
 * - state=solo + config=team → solo
 * - state=regulated + config=team → regulated
 * - no state file + config=team → team
 * - no state file + no config → solo
 * - corrupt state file → throw (fail closed, NOT fallback)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolvePluginSessionPolicy } from './plugin-policy';
import { makeState, FIXED_TIME } from '../__fixtures__';
import type { PolicyMode } from '../config/policy';

function createValidState(policyMode: PolicyMode) {
  const baseState = makeState('TICKET');
  return {
    ...baseState,
    policySnapshot: {
      ...baseState.policySnapshot,
      mode: policyMode,
      requestedMode: policyMode,
    },
  };
}

describe('integration/plugin-policy', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp('/tmp/p32-policy-test-');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // HAPPY: Valid state → state wins
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('HAPPY', () => {
    it('state=solo + config=team → solo (state authority)', async () => {
      const sessDir = path.join(tmpDir, 'sess_solo');
      await fs.mkdir(sessDir, { recursive: true });
      const state = createValidState('solo');
      await fs.writeFile(path.join(sessDir, 'session-state.json'), JSON.stringify(state));

      const result = await resolvePluginSessionPolicy({
        sessDir,
        configDefaultMode: 'team',
      });

      expect(result.policy.mode).toBe('solo');
      expect(result.state).not.toBeNull();
    });

    it('state=regulated + config=team → regulated (state authority)', async () => {
      const sessDir = path.join(tmpDir, 'sess_regulated');
      await fs.mkdir(sessDir, { recursive: true });
      const state = createValidState('regulated');
      await fs.writeFile(path.join(sessDir, 'session-state.json'), JSON.stringify(state));

      const result = await resolvePluginSessionPolicy({
        sessDir,
        configDefaultMode: 'team',
      });

      expect(result.policy.mode).toBe('regulated');
      expect(result.state).not.toBeNull();
    });

    it('state=team-ci + config=team → team-ci (state authority)', async () => {
      const sessDir = path.join(tmpDir, 'sess_teamci');
      await fs.mkdir(sessDir, { recursive: true });
      const state = createValidState('team-ci');
      await fs.writeFile(path.join(sessDir, 'session-state.json'), JSON.stringify(state));

      const result = await resolvePluginSessionPolicy({
        sessDir,
        configDefaultMode: 'team',
      });

      expect(result.policy.mode).toBe('team-ci');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // BAD: Missing/corrupt state → correct fallback or fail
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('BAD', () => {
    it('no state file + config=team → team (config fallback)', async () => {
      const sessDir = path.join(tmpDir, 'sess_no_file');
      await fs.mkdir(sessDir, { recursive: true });
      // No session-state.json

      const result = await resolvePluginSessionPolicy({
        sessDir,
        configDefaultMode: 'team',
      });

      expect(result.policy.mode).toBe('team');
      expect(result.state).toBeNull();
    });

    it('no state file + no config → solo (final fallback)', async () => {
      const sessDir = path.join(tmpDir, 'sess_no_config');
      await fs.mkdir(sessDir, { recursive: true });
      // No session-state.json

      const result = await resolvePluginSessionPolicy({
        sessDir,
      });

      expect(result.policy.mode).toBe('solo');
      expect(result.state).toBeNull();
    });

    it('sessDir=null + config=team → team', async () => {
      const result = await resolvePluginSessionPolicy({
        sessDir: null,
        configDefaultMode: 'team',
      });

      expect(result.policy.mode).toBe('team');
      expect(result.state).toBeNull();
    });

    it('sessDir=null + no config → solo', async () => {
      const result = await resolvePluginSessionPolicy({
        sessDir: null,
      });

      expect(result.policy.mode).toBe('solo');
      expect(result.state).toBeNull();
    });

    it('corrupt state file + config=team → throw (fail closed)', async () => {
      const sessDir = path.join(tmpDir, 'sess_corrupt');
      await fs.mkdir(sessDir, { recursive: true });
      await fs.writeFile(
        path.join(sessDir, 'session-state.json'),
        '{ invalid json that will parse fail }',
      );

      await expect(
        resolvePluginSessionPolicy({
          sessDir,
          configDefaultMode: 'team',
        }),
      ).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // CORNER: Edge of specification
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('CORNER', () => {
    it('config explicitly set to solo → solo used when no state', async () => {
      const sessDir = path.join(tmpDir, 'sess_solo_config');
      await fs.mkdir(sessDir, { recursive: true });
      // No state file

      const result = await resolvePluginSessionPolicy({
        sessDir,
        configDefaultMode: 'solo',
      });

      expect(result.policy.mode).toBe('solo');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // EDGE: Beyond normal specification
  // ═══════════════════════════════════════════════════════════════════════════════
  describe('EDGE', () => {
    it('config=team + state=solo → solo (state beats config)', async () => {
      const sessDir = path.join(tmpDir, 'sess_edge');
      await fs.mkdir(sessDir, { recursive: true });
      const state = createValidState('solo');
      await fs.writeFile(path.join(sessDir, 'session-state.json'), JSON.stringify(state));

      const result = await resolvePluginSessionPolicy({
        sessDir,
        configDefaultMode: 'team',
      });

      expect(result.policy.mode).toBe('solo');
    });
  });
});
