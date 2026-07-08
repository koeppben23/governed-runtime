/**
 * @module integration/plugin-afterhooks.test
 * @description Tests for session-error audit phase enrichment.
 *
 * A silent host/LLM stall surfaces to FlowGuard as a `session.error` event whose
 * hook has no conversation-output channel. The audit trail is therefore the only
 * place FlowGuard can record WHERE the session was, so the phase must be attached
 * when readable and omitted fail-safe when it is not.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeState } from '../adapters/persistence.js';
import { makeState } from '../fixtures.js';
import { resolveSessionErrorPhaseDetail } from './plugin-afterhooks.js';

describe('resolveSessionErrorPhaseDetail (session.error phase enrichment)', () => {
  let sessDir: string;

  beforeEach(async () => {
    sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-sesserr-'));
  });

  afterEach(async () => {
    await fs.rm(sessDir, { recursive: true, force: true });
  });

  // HAPPY — a readable state contributes its phase so a stall is locatable.
  it('returns { phase } from the persisted session state', async () => {
    await writeState(sessDir, makeState('PLAN'));

    expect(await resolveSessionErrorPhaseDetail(sessDir)).toEqual({ phase: 'PLAN' });
  });

  it('reflects the actual phase (IMPLEMENTATION) rather than a fixed value', async () => {
    await writeState(sessDir, makeState('IMPLEMENTATION'));

    expect(await resolveSessionErrorPhaseDetail(sessDir)).toEqual({ phase: 'IMPLEMENTATION' });
  });

  // BAD — session dir exists but the state file is absent: omit phase, never throw.
  it('returns {} when the session dir has no state file (fail-safe)', async () => {
    await expect(resolveSessionErrorPhaseDetail(sessDir)).resolves.toEqual({});
  });

  // CORNER — a non-existent directory must not throw; phase is simply omitted.
  it('returns {} when the directory does not exist (fail-safe)', async () => {
    const missing = path.join(sessDir, 'does-not-exist');

    await expect(resolveSessionErrorPhaseDetail(missing)).resolves.toEqual({});
  });
});
