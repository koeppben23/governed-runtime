/**
 * @module integration/plugin-afterhooks.test
 * @description Tests for session-error audit phase enrichment.
 *
 * A silent host/LLM stall surfaces to FlowGuard as a `session.error` event whose
 * hook has no conversation-output channel. The audit trail is therefore the only
 * place FlowGuard can record WHERE the session was, so the canonical envelope
 * must use the persisted phase.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeState, FROZEN_IMPLEMENTATION_BASE } from '../fixtures.js';
import { appendReviewAuditEventForState } from './review/audit-events.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';

describe('session.error audit envelope', () => {
  let sessDir: string;

  beforeEach(async () => {
    sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-sesserr-'));
  });

  afterEach(async () => {
    await fs.rm(sessDir, { recursive: true, force: true });
  });

  it('uses the resolved state phase in the canonical envelope', async () => {
    const state = makeState('IMPLEMENTATION', {
      implementationBaseAuthority: FROZEN_IMPLEMENTATION_BASE,
    });
    await appendReviewAuditEventForState(sessDir, 'host-session', state, 'error:SESSION_ERROR', {
      code: 'SESSION_ERROR',
      message: 'host stalled',
    });

    const { events } = await readAuditTrail(sessDir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'IMPLEMENTATION',
      flowguardSessionId: state.flowguardSessionId,
      detail: { code: 'SESSION_ERROR', message: 'host stalled' },
    });
  });
});
