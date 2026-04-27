/**
 * @module integration/plugin-workspace.test
 * @description Unit tests for PluginWorkspaceImpl — serialization queue, chain state, session dir.
 *
 * Targets uncovered branches in runSerializedForSession (.catch path)
 * and initChain (GENESIS_HASH fallback).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { PluginWorkspaceImpl, type WorkspaceDeps } from './plugin-workspace.js';
import type { MutableChainState } from './plugin-workspace.js';

function fakeDeps(overrides?: Partial<WorkspaceDeps>): WorkspaceDeps {
  return { auditWorktree: undefined, ...overrides };
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('integration/plugin-workspace', () => {
  describe('PluginWorkspaceImpl', () => {
    describe('HAPPY', () => {
      it('creates instance with default state', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        expect(ws.cachedFingerprint).toBeNull();
        expect(ws.cachedWsDir).toBeNull();
      });

      it('getChainState returns a new state when none exists', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const state = ws.getChainState('session-1');
        expect(state.initialized).toBe(false);
        expect(state.lastHash).toBeNull();
      });

      it('getChainState returns same state for same session', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const a = ws.getChainState('session-1');
        const b = ws.getChainState('session-1');
        expect(a).toBe(b);
      });

      it('invalidateChainState removes session state', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        ws.getChainState('session-1');
        ws.invalidateChainState('session-1');
        const afterInvalidate = ws.getChainState('session-1');
        expect(afterInvalidate.initialized).toBe(false);
      });

      it('resolveFingerprint returns null when no auditWorktree', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const fp = await ws.resolveFingerprint();
        expect(fp).toBeNull();
      });

      it('getSessionDir returns null when no fingerprint', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        expect(ws.getSessionDir('any')).toBeNull();
      });

      it('getEnforcementState returns a fresh state for new session', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const eState = ws.getEnforcementState('s1');
        expect(eState).toBeDefined();
        expect(eState.pendingReviews).toBeDefined();
      });

      it('getEnforcementState returns same state for same session', () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const a = ws.getEnforcementState('s1');
        const b = ws.getEnforcementState('s1');
        expect(a).toBe(b);
      });
    });

    describe('CORNER', () => {
      it('runSerializedForSession handles rejected task gracefully', async () => {
        // Covers line 229: .catch(() => undefined) — error recovery in serialization
        const ws = new PluginWorkspaceImpl(fakeDeps());

        // First task fails — the reject is caught by the serialization queue
        await ws
          .runSerializedForSession('s1', async () => {
            throw new Error('task failed');
          })
          .catch(() => undefined);

        let secondRan = false;
        // Second task should still run despite first one failing
        await ws.runSerializedForSession('s1', async () => {
          secondRan = true;
        });

        expect(secondRan).toBe(true);
      });

      it('runSerializedForSession serializes concurrent tasks', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const order: number[] = [];

        const p1 = ws.runSerializedForSession('s1', async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push(1);
        });
        const p2 = ws.runSerializedForSession('s1', async () => {
          order.push(2);
        });

        await Promise.all([p1, p2]);
        expect(order).toEqual([1, 2]);
      });

      it('different sessions run in parallel', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        let s1Done = false;
        let s2Done = false;

        const p1 = ws.runSerializedForSession('s1', async () => {
          await new Promise((r) => setTimeout(r, 10));
          s1Done = true;
        });
        const p2 = ws.runSerializedForSession('s2', async () => {
          s2Done = true;
        });

        await Promise.all([p1, p2]);
        expect(s1Done).toBe(true);
        expect(s2Done).toBe(true);
      });
    });

    describe('EDGE', () => {
      it('initChain uses GENESIS_HASH when sessDir is null', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const hash = await ws.initChain(null, 's1');
        expect(hash).toBeTruthy();
        expect(typeof hash).toBe('string');
      });

      it('initChain returns same hash when called twice with same session', async () => {
        const ws = new PluginWorkspaceImpl(fakeDeps());
        const h1 = await ws.initChain(null, 's1');
        const h2 = await ws.initChain(null, 's1');
        expect(h1).toBe(h2);
      });
    });
  });
});
