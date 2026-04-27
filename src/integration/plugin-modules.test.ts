/**
 * @module integration/plugin-modules.test
 * @description Unit tests for extracted plugin modules targeting uncovered branches.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect, vi } from 'vitest';
import { createPluginLogger } from './plugin-logging.js';
import {
  parseToolResult,
  strictBlockedOutput,
  getToolOutput,
  getToolArgs,
} from './plugin-helpers.js';
import { updateObligation, blockObligation } from './plugin-review-state.js';
import { trackFlowGuardEnforcement, trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import * as reviewEnforcement from './review-enforcement.js';

vi.mock('./review-enforcement.js', () => ({
  onFlowGuardToolAfter: vi.fn(),
  onTaskToolAfter: vi.fn(),
  resolveSessionEnforcementState: vi.fn(),
}));
import type { SessionState } from '../state/schema.js';
import { makeState } from '../__fixtures__.js';
import type { ReviewObligation } from '../state/evidence.js';

// ─── plugin-helpers.ts ────────────────────────────────────────────────────────

describe('plugin-helpers', () => {
  describe('parseToolResult', () => {
    it('parses valid JSON string', () => {
      expect(parseToolResult('{"key":"val"}')).toEqual({ key: 'val' });
    });

    it('returns null for invalid JSON', () => {
      expect(parseToolResult('not json')).toBeNull();
    });

    it('parses JSON from an object by stringifying', () => {
      // Covers the false path of typeof check
      expect(parseToolResult({ key: 'val' })).toEqual({ key: 'val' });
    });

    it('parses first line when full JSON has trailing text', () => {
      // Covers the second try/catch path
      expect(parseToolResult('{"key":"val"}\nNext action: continue')).toEqual({ key: 'val' });
    });

    it('returns null when first line is empty', () => {
      // Covers the !firstLine.trim() path
      expect(parseToolResult('\n\ntext\n')).toBeNull();
    });

    it('handles null input gracefully', () => {
      expect(parseToolResult(null)).toBeNull();
    });

    it('handles undefined input gracefully', () => {
      expect(parseToolResult(undefined)).toBeNull();
    });

    it('handles array-like non-object input', () => {
      // Arrays serialize to JSON and parse back as arrays
      expect(parseToolResult([1, 2, 3])).toEqual([1, 2, 3]);
    });
  });

  describe('strictBlockedOutput', () => {
    it('returns JSON with error flag and code', () => {
      const output = strictBlockedOutput('TEST_CODE', { reason: 'test' });
      const parsed = JSON.parse(output);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('TEST_CODE');
    });
  });

  describe('getToolOutput', () => {
    it('extracts string output', () => {
      expect(getToolOutput({ output: 'hello' })).toBe('hello');
    });

    it('stringifies non-string output', () => {
      // Covers the false path of typeof inner === 'string'
      expect(getToolOutput({ output: { key: 'val' } })).toBe('{"key":"val"}');
    });

    it('returns empty string for undefined output', () => {
      expect(getToolOutput({})).toBe('""');
    });

    it('returns empty string for null output object', () => {
      expect(getToolOutput(null)).toBe('""');
    });

    it('returns empty string for undefined output object', () => {
      expect(getToolOutput(undefined)).toBe('""');
    });
  });

  describe('getToolArgs', () => {
    it('extracts args from input', () => {
      expect(getToolArgs({ args: { key: 'val' } })).toEqual({ key: 'val' });
    });

    it('returns empty object when args is absent', () => {
      // Covers the ?? {} branch
      expect(getToolArgs({})).toEqual({});
    });
  });
});

// ─── plugin-review-state.ts ────────────────────────────────────────────────────

describe('plugin-review-state', () => {
  function makeObligation(id: string, overrides?: Partial<ReviewObligation>): ReviewObligation {
    return {
      obligationId: id,
      obligationType: 'plan',
      iteration: 0,
      planVersion: 1,
      criteriaVersion: '2.0.0',
      mandateDigest: 'abc123',
      createdAt: '2026-01-01T00:00:00Z',
      pluginHandshakeAt: null,
      status: 'pending',
      invocationId: null,
      blockedCode: null,
      fulfilledAt: null,
      consumedAt: null,
      ...overrides,
    };
  }

  it('updateObligation transforms matching obligation', () => {
    const state = {
      ...makeState('TICKET'),
      reviewAssurance: {
        obligations: [makeObligation('id-1'), makeObligation('id-2')],
        invocations: [],
      },
    } as unknown as SessionState;
    const next = updateObligation(state, 'id-1', (o) => ({ ...o, status: 'fulfilled' }));
    expect(next.reviewAssurance?.obligations[0]?.status).toBe('fulfilled');
    expect(next.reviewAssurance?.obligations[1]?.status).toBe('pending');
  });

  it('blockObligation sets status to blocked', () => {
    const state = {
      ...makeState('TICKET'),
      reviewAssurance: {
        obligations: [makeObligation('id-1')],
        invocations: [],
      },
    } as unknown as SessionState;
    const next = blockObligation(state, 'id-1', 'TEST_CODE');
    expect(next.reviewAssurance?.obligations[0]?.status).toBe('blocked');
    expect(next.reviewAssurance?.obligations[0]?.blockedCode).toBe('TEST_CODE');
  });
});

// ─── plugin-enforcement-tracking.ts ────────────────────────────────────────────

describe('plugin-enforcement-tracking', () => {
  it('trackFlowGuardEnforcement delegates to enforcement module', () => {
    const eState = {} as NonNullable<
      ReturnType<typeof reviewEnforcement.resolveSessionEnforcementState>
    >;
    trackFlowGuardEnforcement(
      eState,
      'flowguard_status',
      { args: {} },
      { output: '{}' },
      new Date().toISOString(),
    );
    expect(reviewEnforcement.onFlowGuardToolAfter).toHaveBeenCalled();
  });

  it('trackTaskEnforcement delegates to enforcement module', () => {
    const eState = {} as NonNullable<
      ReturnType<typeof reviewEnforcement.resolveSessionEnforcementState>
    >;
    trackTaskEnforcement(
      eState,
      { args: { subagent_type: 'flowguard-reviewer' } },
      { output: '{}' },
      new Date().toISOString(),
    );
    expect(reviewEnforcement.onTaskToolAfter).toHaveBeenCalled();
  });
});

// ─── plugin-logging.ts ─────────────────────────────────────────────────────────

describe('plugin-logging', () => {
  describe('createPluginLogger', () => {
    it('falls back to DEFAULT_CONFIG when workspaceDir is null', async () => {
      // Covers line 94: else → DEFAULT_CONFIG
      const { log, config } = await createPluginLogger(undefined, null, undefined, null);
      expect(config).toBeDefined();
      expect(typeof log.info).toBe('function');
    });

    it('falls back to DEFAULT_CONFIG when readConfig throws', async () => {
      // Covers lines 96-98: catch → DEFAULT_CONFIG
      const errorDir = '/nonexistent/path/12345';
      const { log, config } = await createPluginLogger(undefined, errorDir, undefined, null);
      expect(config).toBeDefined();
      expect(typeof log.info).toBe('function');
    });

    it('creates noop logger when no sinks available', async () => {
      // Covers line 107: noop logger path (mode=file but no workspace, mode=ui but no client)
      const { log } = await createPluginLogger(undefined, null, undefined, null);
      // Noop logger still has the same interface
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
    });
  });
});
