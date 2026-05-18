/**
 * @module integration/plugin-compaction.test
 * @description Tests for the OpenCode session compaction hook (plugin-compaction.ts).
 *
 * Validates:
 * - Governance context is built correctly from session state
 * - Missing session or state returns null (fail-safe)
 * - Ticket text is truncated at 200 chars
 * - Pending review obligations are surfaced
 * - Active plan is indicated
 * - Errors are caught and logged (fail-safe)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE ÔÇö all categories present.
 * @version v1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildCompactionContext, type CompactionDeps } from './plugin-compaction.js';

// ÔöÇÔöÇÔöÇ Mock readState ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

// We mock the readState import to control state output
vi.mock('../adapters/persistence.js', () => ({
  readState: vi.fn(),
}));

import { readState } from '../adapters/persistence.js';
const mockReadState = vi.mocked(readState);

// ÔöÇÔöÇÔöÇ Helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

function createMockDeps(sessionDirMap: Record<string, string> = {}): CompactionDeps & {
  warnings: { message: string; extra: Record<string, unknown> }[];
} {
  const warnings: { message: string; extra: Record<string, unknown> }[] = [];
  return {
    warnings,
    getSessionDir(sessionId: string): string | null {
      return sessionDirMap[sessionId] ?? null;
    },
    log: {
      info() {},
      warn(_service, message, extra) {
        warnings.push({ message, extra: extra ?? {} });
      },
    },
  };
}

function createMockState(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-session-id',
    phase: 'PLAN',
    policySnapshot: { mode: 'team' },
    ticket: null,
    plan: null,
    reviewAssurance: { obligations: [] },
    ...overrides,
  };
}

// ÔöÇÔöÇÔöÇ Tests ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

describe('integration/plugin-compaction', () => {
  beforeEach(() => {
    mockReadState.mockReset();
  });

  // ÔöÇÔöÇÔöÇ HAPPY ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('HAPPY', () => {
    it('builds context with phase, policy mode, and session ID', async () => {
      const deps = createMockDeps({ 'sess-1': '/tmp/sess/1' });
      mockReadState.mockResolvedValueOnce(
        createMockState({ id: 'sess-1', phase: 'PLAN', policySnapshot: { mode: 'team' } }),
      );

      const result = await buildCompactionContext(deps, 'sess-1');

      expect(result).not.toBeNull();
      expect(result).toContain('## FlowGuard Governance State');
      expect(result).toContain('**Phase**: Planning (PLAN)');
      expect(result).toContain('**Policy mode**: team');
      expect(result).toContain('**Session ID**: sess-1');
    });

    it('includes ticket text preview in context', async () => {
      const deps = createMockDeps({ 'sess-2': '/tmp/sess/2' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          ticket: {
            text: 'Fix the authentication bug in login flow',
            digest: 'd',
            source: 'user',
            createdAt: '2026-01-01',
          },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-2');

      expect(result).toContain('**Ticket**: Fix the authentication bug in login flow');
    });

    it('includes pending obligation count and warning', async () => {
      const deps = createMockDeps({ 'sess-3': '/tmp/sess/3' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          reviewAssurance: {
            obligations: [{ status: 'pending' }, { status: 'fulfilled' }, { status: 'pending' }],
          },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-3');

      expect(result).toContain('**Pending review obligations**: 2');
      expect(result).toContain('WARNING: Do not skip pending reviews');
    });

    it('indicates active plan exists', async () => {
      const deps = createMockDeps({ 'sess-4': '/tmp/sess/4' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          plan: { current: { body: '## Plan\n1. Do stuff' }, history: [] },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-4');

      expect(result).toContain('**Plan**: Active');
    });

    it('includes /status usage hint at end', async () => {
      const deps = createMockDeps({ 'sess-5': '/tmp/sess/5' });
      mockReadState.mockResolvedValueOnce(createMockState());

      const result = await buildCompactionContext(deps, 'sess-5');

      expect(result).toContain('Use `/status` or `flowguard_status`');
    });

    it('includes diagnostic mandates summary without authorizing mutation', async () => {
      const deps = createMockDeps({ 'sess-mandates': '/tmp/sess/mandates' });
      mockReadState.mockResolvedValueOnce(createMockState({ phase: 'IMPLEMENTATION' }));

      const result = await buildCompactionContext(deps, 'sess-mandates');

      expect(result).toContain('## FlowGuard Diagnostic Mandates Summary');
      expect(result).toContain('## Red Lines');
      expect(result).toContain('## 11a. Tool Error Classification');
      expect(result).toContain('does not authorize mutating runtime behavior');
    });
  });

  // ÔöÇÔöÇÔöÇ BAD ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('BAD', () => {
    it('returns null when getSessionDir returns null', async () => {
      const deps = createMockDeps({}); // No session dirs
      const result = await buildCompactionContext(deps, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns null when readState returns null', async () => {
      const deps = createMockDeps({ 'sess-x': '/tmp/sess/x' });
      mockReadState.mockResolvedValueOnce(null);

      const result = await buildCompactionContext(deps, 'sess-x');
      expect(result).toBeNull();
    });

    it('returns null and logs warning when readState throws', async () => {
      const deps = createMockDeps({ 'sess-err': '/tmp/sess/err' });
      mockReadState.mockRejectedValueOnce(new Error('disk failure'));

      const result = await buildCompactionContext(deps, 'sess-err');

      expect(result).toBeNull();
      expect(deps.warnings).toHaveLength(1);
      expect(deps.warnings[0].message).toBe('failed to build compaction context');
      expect(deps.warnings[0].extra.error).toBe('disk failure');
    });

    it('returns null and logs warning for non-Error thrown values', async () => {
      const deps = createMockDeps({ 'sess-str': '/tmp/sess/str' });
      mockReadState.mockRejectedValueOnce('string error');

      const result = await buildCompactionContext(deps, 'sess-str');

      expect(result).toBeNull();
      expect(deps.warnings[0].extra.error).toBe('string error');
    });
  });

  // ÔöÇÔöÇÔöÇ CORNER ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('CORNER', () => {
    it('truncates ticket text at 200 characters with ellipsis', async () => {
      const longText = 'A'.repeat(300);
      const deps = createMockDeps({ 'sess-long': '/tmp/sess/long' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          ticket: { text: longText, digest: 'd', source: 'user', createdAt: '2026-01-01' },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-long');

      expect(result).toContain('A'.repeat(200) + '...');
      expect(result).not.toContain('A'.repeat(201));
    });

    it('uses sessionId parameter when state.id is undefined', async () => {
      const deps = createMockDeps({ 'sess-noid': '/tmp/sess/noid' });
      mockReadState.mockResolvedValueOnce(createMockState({ id: undefined }));

      const result = await buildCompactionContext(deps, 'sess-noid');

      expect(result).toContain('**Session ID**: sess-noid');
    });

    it('handles state with unknown phase gracefully', async () => {
      const deps = createMockDeps({ 'sess-unk': '/tmp/sess/unk' });
      mockReadState.mockResolvedValueOnce(createMockState({ phase: 'UNKNOWN_PHASE' }));

      const result = await buildCompactionContext(deps, 'sess-unk');

      // Falls back to raw phase string when label doesn't exist
      expect(result).toContain('UNKNOWN_PHASE');
    });

    it('handles policySnapshot without mode (defaults to "unknown")', async () => {
      const deps = createMockDeps({ 'sess-nomode': '/tmp/sess/nomode' });
      mockReadState.mockResolvedValueOnce(createMockState({ policySnapshot: {} }));

      const result = await buildCompactionContext(deps, 'sess-nomode');

      expect(result).toContain('**Policy mode**: unknown');
    });

    it('handles missing policySnapshot entirely', async () => {
      const deps = createMockDeps({ 'sess-nopol': '/tmp/sess/nopol' });
      mockReadState.mockResolvedValueOnce(createMockState({ policySnapshot: null }));

      const result = await buildCompactionContext(deps, 'sess-nopol');

      expect(result).toContain('**Policy mode**: unknown');
    });

    it('handles reviewAssurance with no obligations array', async () => {
      const deps = createMockDeps({ 'sess-noobs': '/tmp/sess/noobs' });
      mockReadState.mockResolvedValueOnce(createMockState({ reviewAssurance: {} }));

      const result = await buildCompactionContext(deps, 'sess-noobs');

      // Should not crash and should not contain pending obligations line
      expect(result).not.toBeNull();
      expect(result).not.toContain('Pending review obligations');
    });
  });

  // ÔöÇÔöÇÔöÇ EDGE ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('EDGE', () => {
    it('ticket text exactly 200 chars is not truncated', async () => {
      const exactText = 'B'.repeat(200);
      const deps = createMockDeps({ 'sess-exact': '/tmp/sess/exact' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          ticket: { text: exactText, digest: 'd', source: 'user', createdAt: '2026-01-01' },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-exact');

      expect(result).toContain(`**Ticket**: ${exactText}`);
      expect(result).not.toContain('...');
    });

    it('ticket text exactly 201 chars is truncated', async () => {
      const overText = 'C'.repeat(201);
      const deps = createMockDeps({ 'sess-over': '/tmp/sess/over' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          ticket: { text: overText, digest: 'd', source: 'user', createdAt: '2026-01-01' },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-over');

      expect(result).toContain('C'.repeat(200) + '...');
    });

    it('all obligations fulfilled means no pending warning', async () => {
      const deps = createMockDeps({ 'sess-done': '/tmp/sess/done' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          reviewAssurance: {
            obligations: [{ status: 'fulfilled' }, { status: 'fulfilled' }],
          },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-done');

      expect(result).not.toContain('Pending review obligations');
      expect(result).not.toContain('WARNING');
    });

    it('plan with empty body does not indicate active plan', async () => {
      const deps = createMockDeps({ 'sess-empty': '/tmp/sess/empty' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          plan: { current: { body: '' }, history: [] },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-empty');

      expect(result).not.toContain('**Plan**');
    });

    it('plan with null current does not indicate active plan', async () => {
      const deps = createMockDeps({ 'sess-nullp': '/tmp/sess/nullp' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          plan: { current: null, history: [] },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-nullp');

      expect(result).not.toContain('**Plan**');
    });
  });

  // ÔöÇÔöÇÔöÇ SMOKE ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('SMOKE', () => {
    it('output is a well-formed markdown string with proper line breaks', async () => {
      const deps = createMockDeps({ 'sess-fmt': '/tmp/sess/fmt' });
      mockReadState.mockResolvedValueOnce(
        createMockState({
          phase: 'IMPLEMENTATION',
          policySnapshot: { mode: 'regulated' },
          ticket: { text: 'Test task', digest: 'd', source: 'user', createdAt: '2026-01-01' },
          plan: { current: { body: 'plan body' }, history: [] },
          reviewAssurance: { obligations: [{ status: 'pending' }] },
        }),
      );

      const result = await buildCompactionContext(deps, 'sess-fmt');
      expect(result).not.toBeNull();

      // Verify markdown structure
      const lines = result!.split('\n');
      expect(lines[0]).toBe('## FlowGuard Governance State (preserved across compaction)');
      expect(lines[1]).toBe(''); // blank line after header

      // Verify all key elements are present
      expect(result).toContain('Implementation in progress (IMPLEMENTATION)');
      expect(result).toContain('regulated');
      expect(result).toContain('Test task');
      expect(result).toContain('Pending review obligations');
      expect(result).toContain('Plan');
      expect(result).toContain('flowguard_status');
    });

    it('building context 100 times completes within budget', async () => {
      const deps = createMockDeps(
        Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`sess-${i}`, `/tmp/sess/${i}`])),
      );
      mockReadState.mockResolvedValue(createMockState());

      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) => buildCompactionContext(deps, `sess-${i}`)),
      );
      const elapsed = performance.now() - start;

      // 100 builds in < 200ms (mocked I/O)
      expect(elapsed).toBeLessThan(200);
      expect(results.every((r) => r !== null)).toBe(true);
    });
  });
});
