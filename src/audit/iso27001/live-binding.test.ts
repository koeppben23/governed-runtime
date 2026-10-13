/**
 * @module audit/iso27001/live-binding.test
 * @description The live `export.completion` binding is only verified after
 * canonical session-bound chain verification, archive-anchor extension, and a
 * canonical materialization event.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../state/evidence.js';
import { getLastChainHash } from '../integrity.js';
import { createTransitionEvent, GENESIS_HASH, type ChainedAuditEvent } from '../types.js';
import { buildChain, SESSION_ID, stampChainSequence, TS3 } from '../audit-test-helpers.js';
import { evaluateLiveExportBinding, type LiveExportBindingInput } from './live-binding.js';

const FOREIGN_SESSION_ID = '00000000-0000-4000-8000-0000000000ff';
const PACKAGE_DIGEST = 'a'.repeat(64);

function materializationEvent(input: {
  readonly sessionId?: string;
  readonly prevHash: string;
  readonly sequence: number;
  readonly target?: string;
}): ChainedAuditEvent {
  const event = createTransitionEvent(
    input.sessionId ?? SESSION_ID,
    'COMPLETE',
    {
      from: 'EXPORT_READY',
      to: input.target ?? 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
      autoAdvanced: false,
      chainIndex: -1,
    } as never,
    TS3,
    input.prevHash,
  );
  return stampChainSequence(event, input.sequence);
}

function withMaterialization(
  prefix: readonly ChainedAuditEvent[],
  overrides: { readonly sessionId?: string; readonly target?: string } = {},
): AuditEvent[] {
  return [
    ...prefix,
    materializationEvent({
      ...overrides,
      prevHash: prefix.at(-1)?.chainHash ?? GENESIS_HASH,
      sequence: prefix.length + 1,
    }),
  ] as AuditEvent[];
}

function inputFrom(
  liveEvents: readonly AuditEvent[],
  overrides: Partial<LiveExportBindingInput> = {},
): LiveExportBindingInput {
  const prefixLength = overrides.archiveAuditEventCount ?? 0;
  return {
    stateAvailable: true,
    exportCompletionPackageDigest: PACKAGE_DIGEST,
    auditReadable: true,
    liveEvents,
    flowguardSessionId: SESSION_ID,
    archiveAuditEventCount: prefixLength,
    archiveAuditChainHead: getLastChainHash([...liveEvents].slice(0, prefixLength)),
    ...overrides,
  };
}

describe('audit/iso27001/live-binding', () => {
  describe('HAPPY — a canonical, anchored materialization verifies', () => {
    it('accepts a chain that extends the archive anchor and materializes terminally', () => {
      const prefix = buildChain(2);
      const events = withMaterialization(prefix);
      const anchorCount = prefix.length;
      const result = evaluateLiveExportBinding(
        inputFrom(events, { archiveAuditEventCount: anchorCount }),
      );
      expect(result.liveChainVerified).toBe(true);
      expect(result.materializedTransitionAt).toBe(TS3);
      expect(result.exportCompletionPackageDigest).toBe(PACKAGE_DIGEST);
    });

    it('keeps the chain verified but reports no materialization when it is absent', () => {
      const prefix = buildChain(2);
      const result = evaluateLiveExportBinding(
        inputFrom(prefix, { archiveAuditEventCount: prefix.length }),
      );
      expect(result.liveChainVerified).toBe(true);
      expect(result.materializedTransitionAt).toBeNull();
    });
  });

  describe('BAD — foreign events, forks and non-terminal targets never verify', () => {
    it('rejects a materialization event from a foreign session', () => {
      const prefix = buildChain(2);
      const events = withMaterialization(prefix, { sessionId: FOREIGN_SESSION_ID });
      const result = evaluateLiveExportBinding(
        inputFrom(events, { archiveAuditEventCount: prefix.length }),
      );
      expect(result.liveChainVerified).toBe(false);
      expect(result.materializedTransitionAt).toBeNull();
    });

    it('rejects a forked trail that does not extend the verified archive anchor', () => {
      const forked = [
        materializationEvent({ prevHash: GENESIS_HASH, sequence: 1 }),
      ] as AuditEvent[];
      const result = evaluateLiveExportBinding(
        inputFrom(forked, { archiveAuditEventCount: 2, archiveAuditChainHead: 'unknown-anchor' }),
      );
      expect(result.liveChainVerified).toBe(false);
      expect(result.materializedTransitionAt).toBeNull();
    });

    it('rejects a materialization whose target is not a terminal phase', () => {
      const prefix = buildChain(2);
      const events = withMaterialization(prefix, { target: 'EXPORT_READY' });
      const result = evaluateLiveExportBinding(
        inputFrom(events, { archiveAuditEventCount: prefix.length }),
      );
      expect(result.liveChainVerified).toBe(true);
      expect(result.materializedTransitionAt).toBeNull();
    });
  });

  describe('CORNER — unreadable inputs degrade to unverified, never positive', () => {
    it('degrades when the audit trail is unreadable', () => {
      const result = evaluateLiveExportBinding(
        inputFrom([], { auditReadable: false, stateAvailable: true }),
      );
      expect(result.liveChainVerified).toBe(false);
      expect(result.materializedTransitionAt).toBeNull();
    });

    it('degrades without a verified FlowGuard session identity', () => {
      const result = evaluateLiveExportBinding(inputFrom([], { flowguardSessionId: null }));
      expect(result.liveChainVerified).toBe(false);
      expect(result.materializedTransitionAt).toBeNull();
    });

    it('preserves the state availability and digest facts unchanged', () => {
      const result = evaluateLiveExportBinding(
        inputFrom([], {
          stateAvailable: false,
          exportCompletionPackageDigest: null,
          auditReadable: false,
        }),
      );
      expect(result.stateAvailable).toBe(false);
      expect(result.exportCompletionPackageDigest).toBeNull();
      expect(result.liveChainVerified).toBe(false);
    });
  });

  describe('EDGE — the newest canonical materialization in the extension wins', () => {
    it('reports the last materialization after the anchor', () => {
      const prefix = buildChain(1);
      const first = withMaterialization(prefix);
      const second = withMaterialization(first);
      const result = evaluateLiveExportBinding(
        inputFrom(second, { archiveAuditEventCount: prefix.length }),
      );
      expect(result.liveChainVerified).toBe(true);
      expect(result.materializedTransitionAt).toBe(TS3);
    });

    it('requires the materialization to lie inside the live extension', () => {
      const prefix = withMaterialization([]);
      const result = evaluateLiveExportBinding(
        inputFrom(prefix, { archiveAuditEventCount: prefix.length }),
      );
      expect(result.liveChainVerified).toBe(true);
      expect(result.materializedTransitionAt).toBeNull();
    });
  });
});
