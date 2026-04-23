import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CheckId,
  ReviewVerdict,
  RevisionDelta,
  LoopVerdict,
  BindingInfo,
  TicketEvidence,
  PlanEvidence,
  PlanRecord,
  SelfReviewLoop,
  ValidationResult,
  ImplEvidence,
  ImplReviewResult,
  ReviewDecision,
  ErrorInfo,
  PolicySnapshotSchema,
  AuditEvent,
  ReviewReport,
} from '../state/evidence.js';
import { Phase, Event, Transition, SessionState } from '../state/schema.js';
import { makeState, FIXED_TIME, FIXED_UUID, FIXED_SESSION_UUID } from '../__fixtures__.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import { readState } from '../adapters/persistence.js';

describe('state schemas', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('Phase parses all 8 valid phases', () => {
      const phases = [
        'TICKET',
        'PLAN',
        'PLAN_REVIEW',
        'VALIDATION',
        'IMPLEMENTATION',
        'IMPL_REVIEW',
        'EVIDENCE_REVIEW',
        'COMPLETE',
      ];
      for (const p of phases) {
        expect(Phase.parse(p)).toBe(p);
      }
    });

    it('Event parses all valid events', () => {
      const events = [
        'PLAN_READY',
        'SELF_REVIEW_MET',
        'SELF_REVIEW_PENDING',
        'APPROVE',
        'CHANGES_REQUESTED',
        'REJECT',
        'ALL_PASSED',
        'CHECK_FAILED',
        'IMPL_COMPLETE',
        'REVIEW_MET',
        'REVIEW_PENDING',
        'ERROR',
        'ABORT',
      ];
      for (const e of events) {
        expect(Event.parse(e)).toBe(e);
      }
    });

    it('TicketEvidence parses valid ticket', () => {
      const ticket = {
        text: 'Fix bug',
        digest: 'abc123',
        source: 'user',
        createdAt: FIXED_TIME,
      };
      expect(TicketEvidence.parse(ticket)).toEqual(ticket);
    });

    it('PlanEvidence parses valid plan', () => {
      const plan = {
        body: '## Plan\nStep 1',
        digest: 'abc',
        sections: ['Plan'],
        createdAt: FIXED_TIME,
      };
      expect(PlanEvidence.parse(plan)).toEqual(plan);
    });

    it('ValidationResult parses valid result', () => {
      const result = {
        checkId: 'test_quality',
        passed: true,
        detail: 'All pass',
        executedAt: FIXED_TIME,
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it('BindingInfo accepts OpenCode-style session IDs', () => {
      const binding = {
        sessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
        worktree: '/tmp/test',
        fingerprint: 'abcdef0123456789abcdef01',
        resolvedAt: FIXED_TIME,
      };
      expect(BindingInfo.parse(binding)).toEqual(binding);
    });

    it('ReviewVerdict parses all 3 verdicts', () => {
      expect(ReviewVerdict.parse('approve')).toBe('approve');
      expect(ReviewVerdict.parse('changes_requested')).toBe('changes_requested');
      expect(ReviewVerdict.parse('reject')).toBe('reject');
    });

    it('SessionState parses a full valid state', () => {
      const state = makeState('TICKET');
      expect(() => SessionState.parse(state)).not.toThrow();
    });

    it('AuditEvent parses valid event with hash chain fields', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: FIXED_SESSION_UUID,
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
        prevHash: 'genesis',
        chainHash: 'abc123',
      };
      expect(() => AuditEvent.parse(event)).not.toThrow();
    });

    it('AuditEvent accepts OpenCode-style non-UUID session IDs', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
        phase: 'READY',
        event: 'tool_call:flowguard_hydrate',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
      };
      expect(() => AuditEvent.parse(event)).not.toThrow();
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('Phase rejects unknown phase', () => {
      expect(() => Phase.parse('UNKNOWN')).toThrow();
    });

    it('Event rejects unknown event', () => {
      expect(() => Event.parse('FIRE')).toThrow();
    });

    it('TicketEvidence rejects empty text', () => {
      expect(() =>
        TicketEvidence.parse({
          text: '',
          digest: 'abc',
          source: 'user',
          createdAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('BindingInfo rejects unsafe session IDs', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: '../etc/passwd',
          worktree: '/tmp/test',
          fingerprint: 'abcdef0123456789abcdef01',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('AuditEvent rejects unsafe session IDs', () => {
      expect(() =>
        AuditEvent.parse({
          id: FIXED_UUID,
          sessionId: 'bad/session',
          phase: 'READY',
          event: 'tool_call:flowguard_hydrate',
          timestamp: FIXED_TIME,
          actor: 'system',
          detail: {},
        }),
      ).toThrow();
    });

    it('TicketEvidence rejects invalid source', () => {
      expect(() =>
        TicketEvidence.parse({
          text: 'Fix bug',
          digest: 'abc',
          source: 'unknown',
          createdAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ReviewVerdict rejects unknown verdict', () => {
      expect(() => ReviewVerdict.parse('maybe')).toThrow();
    });

    it('SelfReviewLoop rejects negative iteration', () => {
      expect(() =>
        SelfReviewLoop.parse({
          iteration: -1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
        }),
      ).toThrow();
    });

    it('SelfReviewLoop rejects zero maxIterations', () => {
      expect(() =>
        SelfReviewLoop.parse({
          iteration: 0,
          maxIterations: 0,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
        }),
      ).toThrow();
    });

    it('SessionState rejects missing required fields', () => {
      expect(() => SessionState.parse({})).toThrow();
    });

    it('SessionState rejects invalid schemaVersion', () => {
      const state = { ...makeState('TICKET'), schemaVersion: 'v2' };
      expect(() => SessionState.parse(state)).toThrow();
    });

    it('PolicySnapshotSchema rejects snapshot missing actorClassification', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('PolicySnapshotSchema rejects snapshot missing requestedMode', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('PolicySnapshotSchema rejects snapshot missing effectiveGateBehavior', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('CheckId accepts any non-empty string', () => {
      expect(CheckId.parse('test_quality')).toBe('test_quality');
      expect(CheckId.parse('custom_check_123')).toBe('custom_check_123');
    });

    it('CheckId rejects empty string', () => {
      expect(() => CheckId.parse('')).toThrow();
    });

    it('PlanRecord with empty history is valid', () => {
      const record = {
        current: {
          body: 'Plan',
          digest: 'abc',
          sections: [],
          createdAt: FIXED_TIME,
        },
        history: [],
      };
      expect(() => PlanRecord.parse(record)).not.toThrow();
    });

    it('PlanEvidence with empty sections array is valid', () => {
      const plan = {
        body: 'No headers here',
        digest: 'abc',
        sections: [],
        createdAt: FIXED_TIME,
      };
      expect(() => PlanEvidence.parse(plan)).not.toThrow();
    });

    it('AuditEvent hash chain fields are optional (legacy compat)', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: FIXED_SESSION_UUID,
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
      };
      expect(() => AuditEvent.parse(event)).not.toThrow();
    });

    it('validation array can be empty', () => {
      const state = makeState('TICKET');
      expect(state.validation).toEqual([]);
      expect(() => SessionState.parse(state)).not.toThrow();
    });

    it('nullable evidence fields accept null', () => {
      const state = makeState('TICKET');
      expect(state.ticket).toBeNull();
      expect(state.plan).toBeNull();
      expect(state.selfReview).toBeNull();
      expect(state.implementation).toBeNull();
      expect(state.implReview).toBeNull();
      expect(state.reviewDecision).toBeNull();
      expect(state.error).toBeNull();
      expect(state.transition).toBeNull();
    });
  });

  // ─── EDGE ──────────────────────────────────────────────────
  describe('EDGE', () => {
    it('RevisionDelta has exactly 3 values', () => {
      expect(RevisionDelta.options).toEqual(['none', 'minor', 'major']);
    });

    it('LoopVerdict has exactly 2 values (no reject)', () => {
      expect(LoopVerdict.options).toEqual(['approve', 'changes_requested']);
    });

    it('PolicySnapshotSchema validates nested audit object', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: true,
        },
        actorClassification: {
          flowguard_decision: 'human',
        },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).not.toThrow();
    });

    it('PolicySnapshotSchema accepts typed jwks identityProvider', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        requireVerifiedActorsForApproval: false,
        identityProvider: {
          mode: 'jwks',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/flowguard/jwks.json',
        },
        identityProviderMode: 'required',
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: true,
        },
        actorClassification: {
          flowguard_decision: 'human',
        },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).not.toThrow();
    });

    it('PolicySnapshotSchema rejects mixed jwks+signingKeys identityProvider', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        minimumActorAssuranceForApproval: 'best_effort',
        requireVerifiedActorsForApproval: false,
        identityProvider: {
          mode: 'jwks',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/flowguard/jwks.json',
          signingKeys: [{ kind: 'pem', kid: 'a', alg: 'RS256', pem: 'pem' }],
        },
        identityProviderMode: 'required',
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: true,
        },
        actorClassification: {
          flowguard_decision: 'human',
        },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('PolicySnapshotSchema accepts P29 applied-policy provenance fields', () => {
      const snapshot = {
        mode: 'regulated',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        source: 'central',
        effectiveGateBehavior: 'human_gated',
        resolutionReason: 'repo_weaker_than_central',
        centralMinimumMode: 'regulated',
        policyDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        policyVersion: '2026.04',
        policyPathHint: 'basename:org-policy.json',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: false,
        requireVerifiedActorsForApproval: false,
        audit: {
          emitTransitions: true,
          emitToolCalls: true,
          enableChainHash: true,
        },
        actorClassification: {
          flowguard_decision: 'human',
        },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).not.toThrow();
    });

    it('ReviewReport validates overall status enum', () => {
      expect(() =>
        ReviewReport.parse({
          schemaVersion: 'flowguard-review-report.v1',
          sessionId: FIXED_UUID,
          generatedAt: FIXED_TIME,
          phase: 'COMPLETE',
          planDigest: null,
          implDigest: null,
          validationSummary: [],
          findings: [],
          overallStatus: 'clean',
        }),
      ).not.toThrow();
    });
  });

  // ─── REHYDRATE (persistence-level fail-closed) ─────────────
  describe('REHYDRATE', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-rehydrate-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    /**
     * Build a valid SessionState JSON, then remove a snapshot field.
     * Written as raw JSON to bypass writeState validation.
     */
    function legacyStateWithout(field: string): string {
      const state = makeState('TICKET');
      const raw = JSON.parse(JSON.stringify(state));
      delete raw.policySnapshot[field];
      return JSON.stringify(raw);
    }

    it('readState rejects legacy snapshot missing actorClassification', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'session-state.json'),
        legacyStateWithout('actorClassification'),
      );
      await expect(readState(tmpDir)).rejects.toThrow(
        /Zod validation.*actorClassification|actorClassification.*Required/s,
      );
    });

    it('readState rejects legacy snapshot missing effectiveGateBehavior', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'session-state.json'),
        legacyStateWithout('effectiveGateBehavior'),
      );
      await expect(readState(tmpDir)).rejects.toThrow(
        /Zod validation.*effectiveGateBehavior|effectiveGateBehavior.*Required/s,
      );
    });

    it('readState rejects legacy snapshot missing requestedMode', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'session-state.json'),
        legacyStateWithout('requestedMode'),
      );
      await expect(readState(tmpDir)).rejects.toThrow(
        /Zod validation.*requestedMode|requestedMode.*Required/s,
      );
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('SessionState serialize + parse roundtrip < 5ms (p99)', () => {
      const state = makeState('TICKET');
      const result = benchmarkSync(
        () => {
          const json = JSON.stringify(state);
          SessionState.parse(JSON.parse(json));
        },
        200,
        50,
      );
      expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.stateSerializeMs);
    });
  });
});
