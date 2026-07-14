import { describe, it, expect } from 'vitest';
import {
  computeChainHash,
  CURRENT_AUDIT_FORMAT_VERSION,
  GENESIS_HASH,
  createTransitionEvent,
  createToolCallEvent,
  createErrorEvent,
  createLifecycleEvent,
  createDecisionEvent,
  summarizeArgs,
  type ChainedAuditEvent,
  type ActorInfo,
} from './types.js';
import { verifyChain } from './integrity.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';
import { SESSION_ID, TS1, TS2, TS3 } from './audit-test-helpers.js';
describe('audit types', () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('computeChainHash produces 64-char hex string', () => {
      const base: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: 'test-id',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
        detail: {},
        prevHash: GENESIS_HASH,
      };
      const hash = computeChainHash(GENESIS_HASH, base);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('createTransitionEvent produces valid chained event', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.phase).toBe('PLAN');
      expect(event.event).toBe('transition:PLAN_READY');
      expect(event.actor).toBe('machine');
      expect(event.auditFormatVersion).toBe(CURRENT_AUDIT_FORMAT_VERSION);
      expect(event.prevHash).toBe(GENESIS_HASH);
      expect(event.chainHash).toMatch(/^[0-9a-f]{64}$/);
      expect(event.detail.kind).toBe('transition');
      expect(event.detail.from).toBe('TICKET');
      expect(event.detail.to).toBe('PLAN');
    });

    it('createToolCallEvent produces valid chained event', () => {
      const event = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'PLAN',
        detail: {
          tool: 'flowguard_plan',
          argsSummary: { text: 'fix auth' },
          success: true,
          transitionCount: 1,
        },
        timestamp: TS1,
        actor: 'user-1',
        prevHash: GENESIS_HASH,
      });
      expect(event.event).toBe('tool_call:flowguard_plan');
      expect(event.actor).toBe('user-1');
      expect(event.detail.kind).toBe('tool_call');
      expect(event.detail.tool).toBe('flowguard_plan');
    });

    it('createErrorEvent produces valid chained event', () => {
      const event = createErrorEvent(
        SESSION_ID,
        { code: 'TOOL_ERROR', message: 'oops', recoveryHint: 'retry', errorPhase: 'PLAN' },
        TS1,
        GENESIS_HASH,
      );
      expect(event.event).toBe('error:TOOL_ERROR');
      expect(event.phase).toBe('PLAN');
      expect(event.detail.kind).toBe('error');
    });

    it('createLifecycleEvent produces valid chained event', () => {
      const event = createLifecycleEvent({
        sessionId: SESSION_ID,
        detail: { action: 'session_created', finalPhase: 'TICKET' },
        timestamp: TS1,
        actor: 'system',
        prevHash: GENESIS_HASH,
      });
      expect(event.event).toBe('lifecycle:session_created');
      expect(event.actor).toBe('system');
      expect(event.detail.kind).toBe('lifecycle');
    });

    it('createDecisionEvent produces valid chained event', () => {
      const event = createDecisionEvent({
        sessionId: SESSION_ID,
        gatePhase: 'PLAN_REVIEW',
        detail: {
          decisionId: 'DEC-001',
          decisionSequence: 1,
          verdict: 'approve',
          rationale: 'LGTM',
          decidedBy: 'reviewer-1',
          decidedAt: TS1,
          fromPhase: 'PLAN_REVIEW',
          toPhase: 'VALIDATION',
          transitionEvent: 'APPROVE',
          policyMode: 'team',
        },
        timestamp: TS1,
        actor: 'human',
        prevHash: GENESIS_HASH,
      });
      expect(event.event).toBe('decision:DEC-001');
      expect(event.phase).toBe('PLAN_REVIEW');
      expect(event.detail.kind).toBe('decision');
      expect(event.detail.decisionSequence).toBe(1);
    });

    // ─── P27: Actor Identity ───────────────────────────────────

    it('lifecycle event contains actorInfo when provided', () => {
      const actor: ActorInfo = {
        id: 'jane',
        email: 'jane@dev.io',
        source: 'git',
        assurance: 'best_effort',
      };
      const event = createLifecycleEvent({
        sessionId: SESSION_ID,
        detail: { action: 'session_created', finalPhase: 'TICKET' },
        timestamp: TS1,
        actor: 'system',
        prevHash: GENESIS_HASH,
        actorInfo: actor,
      });
      expect(event.actorInfo).toEqual(actor);
      expect(event.actor).toBe('system');
    });

    it('tool_call event contains actorInfo when provided', () => {
      const actor: ActorInfo = {
        id: 'ci-bot',
        email: null,
        source: 'env',
        assurance: 'best_effort',
      };
      const event = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'PLAN',
        detail: { tool: 'flowguard_plan', argsSummary: {}, success: true, transitionCount: 1 },
        timestamp: TS1,
        actor: 'user',
        prevHash: GENESIS_HASH,
        actorInfo: actor,
      });
      expect(event.actorInfo).toEqual(actor);
      expect(event.actor).toBe('user');
    });

    it('decision event contains actorInfo when provided', () => {
      const actor: ActorInfo = {
        id: 'reviewer',
        email: 'rev@co.com',
        source: 'env',
        assurance: 'best_effort',
      };
      const event = createDecisionEvent({
        sessionId: SESSION_ID,
        gatePhase: 'PLAN_REVIEW',
        detail: {
          decisionId: 'DEC-002',
          decisionSequence: 1,
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'reviewer',
          decidedAt: TS1,
          fromPhase: 'PLAN_REVIEW',
          toPhase: 'VALIDATION',
          transitionEvent: 'APPROVE',
          policyMode: 'team',
        },
        timestamp: TS1,
        actor: 'human',
        prevHash: GENESIS_HASH,
        actorInfo: actor,
      });
      expect(event.actorInfo).toEqual(actor);
    });

    it('sessionID is still present separately from actorInfo', () => {
      const actor: ActorInfo = { id: 'dev1', email: null, source: 'git', assurance: 'best_effort' };
      const event = createLifecycleEvent({
        sessionId: SESSION_ID,
        detail: { action: 'session_created', finalPhase: 'TICKET' },
        timestamp: TS1,
        actor: 'system',
        prevHash: GENESIS_HASH,
        actorInfo: actor,
      });
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.actorInfo).toBeDefined();
      expect(event.sessionId).not.toBe(event.actorInfo!.id);
    });

    it('summarizeArgs handles all scalar types', () => {
      const result = summarizeArgs({
        str: 'hello',
        num: 42,
        bool: true,
        nil: null,
        undef: undefined,
      });
      expect(result.str).toBe('hello');
      expect(result.num).toBe('42');
      expect(result.bool).toBe('true');
      expect(result.nil).toBe('null');
      expect(result.undef).toBe('null');
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe('BAD', () => {
    it('summarizeArgs replaces objects and arrays with type indicators', () => {
      const result = summarizeArgs({
        arr: [1, 2, 3],
        obj: { nested: true },
        emptyArr: [],
      });
      expect(result.arr).toBe('[Array(3)]');
      expect(result.obj).toBe('[Object]');
      expect(result.emptyArr).toBe('[Array(0)]');
    });

    it('summarizeArgs redacts scalar string values on secret-bearing keys', () => {
      const result = summarizeArgs({
        api_key: 'sk-abc123def456',
        token: 'ghp_secret123',
        password: 'hunter2',
        secret: 'my-secret-value',
        credential: 'creds-xyz',
        authorization: 'Bearer tok123',
        access_key: 'AKIA123',
        private_key: '-----BEGIN RSA PRIVATE KEY-----',
        passphrase: 'correct horse battery staple',
        aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
        client_secret_value: 'shhh',
        github_token_value: 'gh_token',
      });
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
      expect(result.password).toBe('[REDACTED]');
      expect(result.secret).toBe('[REDACTED]');
      expect(result.credential).toBe('[REDACTED]');
      expect(result.authorization).toBe('[REDACTED]');
      expect(result.access_key).toBe('[REDACTED]');
      expect(result.private_key).toBe('[REDACTED]');
      expect(result.passphrase).toBe('[REDACTED]');
      expect(result.aws_access_key_id).toBe('[REDACTED]');
      expect(result.client_secret_value).toBe('[REDACTED]');
      expect(result.github_token_value).toBe('[REDACTED]');
    });

    it('summarizeArgs redacts non-string values on secret-bearing keys', () => {
      const result = summarizeArgs({
        api_key: true,
        token: 12345,
        password: null as unknown,
      });
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
      expect(result.password).toBe('[REDACTED]');
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe('CORNER', () => {
    it('summarizeArgs truncates strings > 100 chars', () => {
      const long = 'x'.repeat(150);
      const result = summarizeArgs({ long });
      expect(result.long).toBe('x'.repeat(100) + '...');
      expect(result.long!.length).toBe(103);
    });

    it('summarizeArgs handles empty args', () => {
      expect(summarizeArgs({})).toEqual({});
    });

    it('summarizeArgs redacts only secret-bearing keys, preserving non-secret keys', () => {
      const result = summarizeArgs({
        prompt: 'write a function',
        file: 'src/main.ts',
        language: 'typescript',
        api_key: 'sk-abc',
        token: 'ghp_xyz',
      });
      expect(result.prompt).toBe('write a function');
      expect(result.file).toBe('src/main.ts');
      expect(result.language).toBe('typescript');
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
    });

    it('summarizeArgs secret-key detection is case-insensitive', () => {
      const result = summarizeArgs({
        Api_Key: 'val1',
        API_KEY: 'val2',
        api_key: 'val3',
        TOKEN: 'val4',
      });
      expect(result.Api_Key).toBe('[REDACTED]');
      expect(result.API_KEY).toBe('[REDACTED]');
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.TOKEN).toBe('[REDACTED]');
    });

    it('summarizeArgs does not redact false-positive key names', () => {
      const result = summarizeArgs({
        monkey: 'a monkey value',
        keyboard_layout: 'qwerty',
        donkey: 'not an api key',
      });
      expect(result.monkey).toBe('a monkey value');
      expect(result.keyboard_layout).toBe('qwerty');
      expect(result.donkey).toBe('not an api key');
    });

    it('summarizeArgs redacts camelCase secret-bearing keys via contains', () => {
      const result = summarizeArgs({
        clientApiKey: 'sk-abc',
        myAccessKey: 'AKIA123',
        signingPrivateKey: '-----BEGIN KEY-----',
        githubToken: 'ghp_xyz',
      });
      expect(result.clientApiKey).toBe('[REDACTED]');
      expect(result.myAccessKey).toBe('[REDACTED]');
      expect(result.signingPrivateKey).toBe('[REDACTED]');
      expect(result.githubToken).toBe('[REDACTED]');
    });

    it('summarizeArgs scrubs content-level secrets on non-secret keys via sanitizeDiagnosticString', () => {
      const result = summarizeArgs({
        notes: 'token: sk-live-abc123 and Bearer ghp_def456',
        description: 'key at /home/user/.ssh/id_rsa with password=secret123',
      });
      expect(result.notes).not.toContain('sk-live-abc123');
      expect(result.notes).not.toContain('ghp_def456');
      expect(result.notes).toContain('[redacted]');
      expect(result.description).toContain('[path:id_rsa]');
      expect(result.description).toContain('password=[redacted]');
      expect(result.description).not.toContain('secret123');
    });

    it('summarizeArgs preserves diagnostic context after content scrubbing', () => {
      const result = summarizeArgs({
        message: 'Connection to https://api.example.com/v2 failed at file: /app/config.ts:42:15',
      });
      expect(result.message).toContain('[url:api.example.com]');
      expect(result.message).toContain('[path:config.ts]');
      expect(result.message).not.toContain('/app/config.ts');
      expect(result.message).not.toContain('/v2');
    });

    it('summarizeArgs sanitizes before truncating so truncated secrets still match regex minimums', () => {
      const prefix = 'x'.repeat(80);
      const secret = 'Bearer ghp_abcdefghijklmnopqrstuvwxyz123456';
      const long = `${prefix} ${secret}`;
      expect(long.length).toBeGreaterThan(100);

      const result = summarizeArgs({ value: long });
      expect(result.value).not.toContain('ghp_');
      expect(result.value).toContain('Bearer [redacted]');
      expect(result.value!.length).toBe(103);
    });

    it("GENESIS_HASH is 'genesis'", () => {
      expect(GENESIS_HASH).toBe('genesis');
    });

    it('createTransitionEvent with autoAdvanced=true records chain index', () => {
      const event = createTransitionEvent(
        SESSION_ID,
        'PLAN_REVIEW',
        { from: 'PLAN', to: 'PLAN_REVIEW', event: 'PLAN_READY', autoAdvanced: true, chainIndex: 2 },
        TS1,
        GENESIS_HASH,
      );
      expect(event.detail.autoAdvanced).toBe(true);
      expect(event.detail.chainIndex).toBe(2);
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe('EDGE', () => {
    it('computeChainHash is deterministic (same input → same output)', () => {
      const base: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: 'deterministic-test',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
        detail: {},
        prevHash: GENESIS_HASH,
      };
      const hash1 = computeChainHash(GENESIS_HASH, base);
      const hash2 = computeChainHash(GENESIS_HASH, base);
      expect(hash1).toBe(hash2);
    });

    it('computeChainHash differs with different prevHash', () => {
      const base: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: 'test-id',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
        detail: {},
        prevHash: 'hash-a',
      };
      const hash1 = computeChainHash('hash-a', base);
      const hash2 = computeChainHash('hash-b', { ...base, prevHash: 'hash-b' });
      expect(hash1).not.toBe(hash2);
    });

    it('factory event names encode the kind as prefix', () => {
      const t = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      const tc = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'PLAN',
        detail: { tool: 'test', argsSummary: {}, success: true, transitionCount: 0 },
        timestamp: TS1,
        actor: 'user',
        prevHash: GENESIS_HASH,
      });
      const e = createErrorEvent(
        SESSION_ID,
        { code: 'ERR', message: 'msg', recoveryHint: 'fix', errorPhase: 'PLAN' },
        TS1,
        GENESIS_HASH,
      );
      const l = createLifecycleEvent({
        sessionId: SESSION_ID,
        detail: { action: 'session_created', finalPhase: 'TICKET' },
        timestamp: TS1,
        actor: 'system',
        prevHash: GENESIS_HASH,
      });
      const d = createDecisionEvent({
        sessionId: SESSION_ID,
        gatePhase: 'PLAN_REVIEW',
        detail: {
          decisionId: 'DEC-001',
          decisionSequence: 1,
          verdict: 'approve',
          rationale: 'ok',
          decidedBy: 'r',
          decidedAt: TS1,
          fromPhase: 'PLAN_REVIEW',
          toPhase: 'VALIDATION',
          transitionEvent: 'APPROVE',
          policyMode: 'team',
        },
        timestamp: TS1,
        actor: 'human',
        prevHash: GENESIS_HASH,
      });

      expect(t.event).toMatch(/^transition:/);
      expect(tc.event).toMatch(/^tool_call:/);
      expect(e.event).toMatch(/^error:/);
      expect(l.event).toMatch(/^lifecycle:/);
      expect(d.event).toMatch(/^decision:/);
    });

    // ─── P27: Hash Backward Compatibility ──────────────────────

    it('event without actorInfo has same hash as event created before P27', () => {
      // Simulate a "pre-P27" event — no actorInfo parameter
      const withoutActor = createLifecycleEvent({
        sessionId: SESSION_ID,
        detail: { action: 'session_created', finalPhase: 'TICKET' },
        timestamp: TS1,
        actor: 'system',
        prevHash: GENESIS_HASH,
      });
      // actorInfo should be absent from the object (not undefined-as-value)
      expect('actorInfo' in withoutActor).toBe(false);

      // Manually build the same v2 event object as pre-P27 code would have produced.
      const prePatchEvent: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: withoutActor.id,
        sessionId: withoutActor.sessionId,
        phase: withoutActor.phase,
        event: withoutActor.event,
        timestamp: withoutActor.timestamp,
        actor: withoutActor.actor,
        auditFormatVersion: withoutActor.auditFormatVersion,
        detail: withoutActor.detail,
        prevHash: withoutActor.prevHash,
      };
      const prePatchHash = computeChainHash(GENESIS_HASH, prePatchEvent);
      expect(withoutActor.chainHash).toBe(prePatchHash);
    });

    it('actorInfo changes the chain hash (isolated, same event body)', () => {
      const actor: ActorInfo = { id: 'dev', email: null, source: 'git', assurance: 'best_effort' };
      const sharedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const base = {
        id: sharedId,
        sessionId: SESSION_ID,
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        timestamp: TS1,
        actor: 'system',
        auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
        detail: { kind: 'lifecycle', action: 'session_created', finalPhase: 'TICKET' },
        prevHash: GENESIS_HASH,
      };
      const withActorInfo = { ...base, actorInfo: actor };

      const hashWithout = computeChainHash(GENESIS_HASH, base);
      const hashWith = computeChainHash(GENESIS_HASH, withActorInfo);

      // Same body, same ID — only actorInfo differs → different hash
      expect(hashWithout).toMatch(/^[0-9a-f]{64}$/);
      expect(hashWith).toMatch(/^[0-9a-f]{64}$/);
      expect(hashWithout).not.toBe(hashWith);
    });

    it('actorInfo absent on transition and error events', () => {
      const transition = createTransitionEvent(
        SESSION_ID,
        'PLAN',
        { from: 'TICKET', to: 'PLAN', event: 'PLAN_READY', autoAdvanced: false, chainIndex: -1 },
        TS1,
        GENESIS_HASH,
      );
      const error = createErrorEvent(
        SESSION_ID,
        { code: 'ERR', message: 'msg', recoveryHint: 'fix', errorPhase: 'PLAN' },
        TS1,
        GENESIS_HASH,
      );
      expect('actorInfo' in transition).toBe(false);
      expect('actorInfo' in error).toBe(false);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe('PERF', () => {
    it('computeChainHash < 1ms (p99 over 200 iterations)', () => {
      const base: Omit<ChainedAuditEvent, 'chainHash'> = {
        id: 'perf-test',
        sessionId: SESSION_ID,
        phase: 'PLAN',
        event: 'transition:PLAN_READY',
        timestamp: TS1,
        actor: 'machine',
        auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
        detail: { kind: 'transition', from: 'TICKET', to: 'PLAN' },
        prevHash: GENESIS_HASH,
      };
      const { p99Ms } = benchmarkSync(() => computeChainHash(GENESIS_HASH, base), 200, 50);
      expect(p99Ms).toBeLessThan(PERF_BUDGETS.evaluateSingleMs); // 1ms
    });
  });

  // ─── AC3: Audit chain integrity after secret-key redaction ─────────

  describe('AUDIT CHAIN INTEGRITY', () => {
    it('chain remains valid after summarizeArgs redacts secret-bearing keys', () => {
      const canary = 'sk-canary-audit-chain-test';

      const event = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'PLAN',
        detail: {
          tool: 'bash',
          argsSummary: summarizeArgs({ api_key: canary, prompt: 'hello' }),
          success: true,
          transitionCount: 1,
        },
        timestamp: TS1,
        actor: 'human',
        prevHash: GENESIS_HASH,
      });

      expect((event.detail.argsSummary as Record<string, string>).api_key).toBe('[REDACTED]');
      expect(JSON.stringify(event)).not.toContain(canary);

      const result = verifyChain([event as unknown as Record<string, unknown>]);
      expect(result.valid).toBe(true);
    });

    it('multi-event chain with secret-bearing args remains valid', () => {
      const event1 = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'PLAN',
        detail: {
          tool: 'bash',
          argsSummary: summarizeArgs({ token: 'ghp_secret', prompt: 'plan' }),
          success: true,
          transitionCount: 1,
        },
        timestamp: TS1,
        actor: 'human',
        prevHash: GENESIS_HASH,
      });

      const event2 = createToolCallEvent({
        sessionId: SESSION_ID,
        phase: 'IMPLEMENTATION',
        detail: {
          tool: 'write_file',
          argsSummary: summarizeArgs({ file: 'src/app.ts', api_key: 'sk-abc' }),
          success: true,
          transitionCount: 2,
        },
        timestamp: TS2,
        actor: 'human',
        prevHash: event1.chainHash,
      });

      expect((event1.detail.argsSummary as Record<string, string>).token).toBe('[REDACTED]');
      expect(JSON.stringify(event1)).not.toContain('ghp_secret');
      expect((event2.detail.argsSummary as Record<string, string>).api_key).toBe('[REDACTED]');

      const result = verifyChain([
        event1 as unknown as Record<string, unknown>,
        event2 as unknown as Record<string, unknown>,
      ]);
      expect(result.valid).toBe(true);
    });
  });
});
