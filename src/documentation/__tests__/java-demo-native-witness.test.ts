/** Single-invariant counterexamples against the actual native evidence validators. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertNativeCommandWitness } from '../../../demos/java-task-manager/live-native-command-witness.mjs';
import { assertNativeDecisionWitness } from '../../../demos/java-task-manager/live-decision-witness.mjs';
import { computeStateDigest } from '../../integration/audit-outbox.js';

const SESSION = 'ses_root';
const FG = 'fg_root';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const END = START + 100;
const at = (ms: number) => new Date(START + ms).toISOString();
const hash = (letter = 'a') => letter.repeat(64);
const digestOf = (value: unknown) => computeStateDigest(value as never);
const DENIAL = 'GOVERNANCE_OVERRIDE_REQUIRED';
const RATIONALE = 'The accepted plan preserves the stated constraints.';

interface Event {
  auditSequence: number;
  flowguardSessionId: string;
  hostSessionId: string | undefined;
  occurredAt: string;
  event: string;
  detail: Record<string, unknown>;
  chainHash: string;
  phase?: string;
  id?: string;
}
const event = (event: string, detail: Event['detail'], ms = 0): Event => ({
  auditSequence: 0,
  flowguardSessionId: FG,
  hostSessionId: SESSION,
  occurredAt: at(ms),
  event,
  detail,
  chainHash: hash('b'),
});
const sequence = (...events: Event[]) =>
  events.map((item, index) => ({ ...item, auditSequence: index + 1 }));
const state = (phase: string) => ({
  flowguardSessionId: FG,
  binding: { hostSessionId: SESSION, worktree: '/fixture' },
  pendingAuditOperations: [] as Array<{ status: string }>,
  auditOutboxCheckpoint: undefined as { auditSequence: number; chainHash: string } | undefined,
  policySnapshot: { hash: hash('c') },
  phase,
});
const common = { sessionId: SESSION, startedAt: START, completedAt: END };
const old = event('tool_call:flowguard_status', { argsSummary: { callID: 'old' } }, -10);
const checkTool = 'flowguard_run_check';
const checkCall = (id: string, time: number) =>
  event(
    `tool_call:${checkTool}`,
    {
      tool: checkTool,
      success: true,
      transitionCount: 0,
      argsSummary: { sessionID: SESSION, callID: id },
    },
    time,
  );
const checkAttempt = (attemptId: string, time: number, scope: string) => ({
  scope,
  planDigest: hash(),
  implementationId: 'implementation-1',
  implementationDigest: hash('d'),
  attemptId,
  result: { checkId: 'test', executedAt: at(time), outputDigest: hash('e'), passed: false },
});

function check(scope = 'baseline') {
  const before = {
    ...state(scope === 'baseline' ? 'VALIDATION' : 'IMPL_VALIDATION'),
    plan: { current: { digest: hash() } },
    implementation: { implementationId: 'implementation-1', digest: hash('d') },
    validationAttempts: [checkAttempt('past-attempt', -20, scope)],
  };
  const after = {
    ...structuredClone(before),
    validationAttempts: [
      ...structuredClone(before.validationAttempts),
      checkAttempt('attempt-1', 0, scope),
      checkAttempt('attempt-2', 50, scope),
    ],
    auditOutboxCheckpoint: { auditSequence: 3, chainHash: hash('b') },
  };
  return {
    ...common,
    command: 'check',
    before,
    after,
    auditBefore: sequence(old),
    events: sequence(old, checkCall('first', 50), checkCall('second', 100)),
  };
}

function start() {
  const after = state('READY');
  const activation = {
    ...event('governance:activated', {
      activationId: 'activation',
      decisionId: 'decision',
      channel: 'host_command',
      rootSessionId: SESSION,
      worktreeRoot: after.binding.worktree,
      policyDigest: after.policySnapshot.hash,
    }),
    id: 'activation',
    phase: 'READY',
  };
  return {
    ...common,
    command: 'start',
    before: null as ReturnType<typeof state> | null,
    after,
    auditBefore: [] as Event[],
    events: sequence(activation),
  };
}

describe('native command witness invariants', () => {
  it.each(['baseline', 'implementation'])(
    'accepts two ordered %s calls even if the check failed',
    (scope) => {
      const run = check(scope);
      expect(assertNativeCommandWitness(run)).toEqual(run.events.slice(1));
    },
  );

  it('credits the exact activation suffix', () => {
    const run = start();
    expect(assertNativeCommandWitness(run)).toEqual(run.events);
  });

  const badActivation: Array<[string, (run: ReturnType<typeof start>) => void]> = [
    [
      'unsupported command',
      (run) => {
        run.command = 'other';
      },
    ],
    [
      'existing state',
      (run) => {
        run.before = state('READY');
      },
    ],
    [
      'existing audit',
      (run) => {
        run.auditBefore = sequence(old);
        run.events = sequence(old, ...run.events);
      },
    ],
    [
      'wrong root',
      (run) => {
        run.events[0]!.detail.rootSessionId = 'ses_other';
      },
    ],
    [
      'wrong phase',
      (run) => {
        run.events[0]!.phase = 'PLAN';
      },
    ],
    [
      'wrong policy',
      (run) => {
        run.events[0]!.detail.policyDigest = hash('d');
      },
    ],
    [
      'forged policy shape',
      (run) => {
        run.events[0]!.detail.policyDigest = run.after.policySnapshot.hash = 'bad';
      },
    ],
    [
      'empty identity',
      (run) => {
        run.events[0]!.detail.activationId = run.events[0]!.id = '';
      },
    ],
    [
      'non-string identity',
      (run) => {
        Reflect.set(run.events[0]!, 'id', ['activation']);
        run.events[0]!.detail.activationId = run.events[0]!.id;
      },
    ],
    [
      'missing decision',
      (run) => {
        delete run.events[0]!.detail.decisionId;
      },
    ],
    [
      'mismatched activation ID',
      (run) => {
        run.events[0]!.id = 'other';
      },
    ],
    [
      'subsequent end',
      (run) => {
        run.events = sequence(...run.events, event('governance:ended', {}));
      },
    ],
  ];
  it.each(badActivation)('rejects an activation with %s', (_name, change) => {
    const run = start();
    change(run);
    expect(() => assertNativeCommandWitness(run)).toThrow(
      `native /${run.command} has no unique current command witness`,
    );
  });

  const badWindow: Array<[string, (run: ReturnType<typeof check>) => void]> = [
    [
      'wrong host dispatch',
      (run) => {
        run.sessionId = 'ses_other';
      },
    ],
    [
      'missing event binding',
      (run) => {
        run.events[2]!.hostSessionId = undefined;
      },
    ],
    [
      'post-dispatch suffix',
      (run) => {
        run.events[2]!.occurredAt = at(101);
      },
    ],
    [
      'missing checkpoint',
      (run) => {
        run.after.auditOutboxCheckpoint.auditSequence = 99;
      },
    ],
    [
      'wrong checkpoint',
      (run) => {
        run.after.auditOutboxCheckpoint.chainHash = hash('d');
      },
    ],
  ];
  it.each(badWindow)('rejects an audit interval with %s', (_name, change) => {
    const run = check();
    change(run);
    expect(() => assertNativeCommandWitness(run)).toThrow(
      'native /check has no continuous dispatch-bound audit window',
    );
  });

  const badCheck: Array<[string, (run: ReturnType<typeof check>) => void]> = [
    [
      'unsupported command',
      (run) => {
        run.command = 'other';
      },
    ],
    [
      'changed session authority',
      (run) => {
        run.before.flowguardSessionId = 'fg_old';
      },
    ],
    [
      'old foreign binding',
      (run) => {
        run.before.binding.hostSessionId = 'ses_other';
      },
    ],
    [
      'governance change',
      (run) => {
        run.events = sequence(...run.events, event('governance:ended', {}));
      },
    ],
    [
      'rewritten ledger',
      (run) => {
        run.after.validationAttempts[0]!.attemptId = 'rewritten';
      },
    ],
    [
      'old malformed ledger',
      (run) => {
        Reflect.set(run.before, 'validationAttempts', undefined);
      },
    ],
    [
      'new malformed ledger',
      (run) => {
        Reflect.set(run.after, 'validationAttempts', undefined);
      },
    ],
    [
      'extra attempt',
      (run) => {
        run.after.validationAttempts.push(checkAttempt('extra', 60, 'baseline'));
      },
    ],
    [
      'reused past attempt',
      (run) => {
        run.after.validationAttempts[1]!.attemptId = 'past-attempt';
      },
    ],
    [
      'reused current attempt',
      (run) => {
        run.after.validationAttempts[2]!.attemptId = 'attempt-1';
      },
    ],
    [
      'empty attempt identity',
      (run) => {
        run.after.validationAttempts[2]!.attemptId = '';
      },
    ],
    [
      'missing attempt',
      (run) => {
        Reflect.set(run.after.validationAttempts, 2, undefined);
      },
    ],
    [
      'empty check identity',
      (run) => {
        run.after.validationAttempts[2]!.result.checkId = '';
      },
    ],
    [
      'bad digest alphabet',
      (run) => {
        run.after.validationAttempts[2]!.result.outputDigest = hash('g');
      },
    ],
    [
      'bad digest prefix',
      (run) => {
        run.after.validationAttempts[2]!.result.outputDigest = `_${hash()}`;
      },
    ],
    [
      'bad digest suffix',
      (run) => {
        run.after.validationAttempts[2]!.result.outputDigest = `${hash()}_`;
      },
    ],
    [
      'late attempt',
      (run) => {
        run.after.validationAttempts[2]!.result.executedAt = at(101);
      },
    ],
    [
      'attempt after its call',
      (run) => {
        run.after.validationAttempts[1]!.result.executedAt = at(51);
      },
    ],
    [
      'attempt before preceding call',
      (run) => {
        run.after.validationAttempts[2]!.result.executedAt = at(49);
      },
    ],
    [
      'untyped check outcome',
      (run) => {
        run.events[2]!.detail.success = 'true';
      },
    ],
    [
      'wrong tool label',
      (run) => {
        run.events[2]!.detail.tool = 'flowguard_status';
      },
    ],
    [
      'negative transition count',
      (run) => {
        run.events[2]!.detail.transitionCount = -1;
      },
    ],
    [
      'noninteger transition count',
      (run) => {
        run.events[2]!.detail.transitionCount = 0.5;
      },
    ],
    [
      'empty call identity',
      (run) => {
        run.events[2]!.detail.argsSummary = { sessionID: SESSION, callID: '' };
      },
    ],
    [
      'another tool reuses the call ID',
      (run) => {
        run.events = sequence(
          ...run.events,
          event('tool_call:flowguard_status', { argsSummary: { callID: 'second' } }, 100),
        );
      },
    ],
    [
      'wrong phase',
      (run) => {
        run.before.phase = 'READY';
      },
    ],
    [
      'wrong scope',
      (run) => {
        run.after.validationAttempts[2]!.scope = 'implementation';
      },
    ],
    [
      'malformed plan digest',
      (run) => {
        run.after.validationAttempts[1]!.planDigest =
          run.after.validationAttempts[2]!.planDigest =
          run.before.plan.current.digest =
            'invalid';
      },
    ],
    [
      'empty implementation identity',
      (run) => {
        Object.assign(run, check('implementation'));
        run.after.validationAttempts[2]!.implementationId =
          run.before.implementation.implementationId = '';
      },
    ],
    [
      'malformed implementation digest',
      (run) => {
        Object.assign(run, check('implementation'));
        run.after.validationAttempts[1]!.implementationDigest =
          run.after.validationAttempts[2]!.implementationDigest =
          run.before.implementation.digest =
            'invalid';
      },
    ],
  ];
  it.each(badCheck)('rejects otherwise valid checks with %s', (_name, change) => {
    const run = check();
    change(run);
    expect(() => assertNativeCommandWitness(run)).toThrow(
      `native /${run.command} has no unique current command witness`,
    );
  });
});

function approval() {
  const before = state('PLAN_REVIEW');
  const intermediate = state('VALIDATION');
  const after = state('IMPLEMENTATION');
  const preStateDigest = digestOf(before);
  const postStateDigest = digestOf(intermediate);
  const transition = event('transition:APPROVE', {
    from: before.phase,
    to: intermediate.phase,
    preStateDigest,
    postStateDigest,
  });
  const operation = {
    source: 'host_command',
    sessionId: SESSION,
    rootSessionId: SESSION,
    operationId: 'op',
    stateDigest: preStateDigest,
    verdict: 'approve',
    rationaleDigest: createHash('sha256').update(RATIONALE).digest('hex'),
  };
  const receipt = event(
    'decision:DEC-001',
    {
      verdict: 'approve',
      rationale: RATIONALE,
      stateChanged: true,
      fromPhase: before.phase,
      toPhase: intermediate.phase,
      transitionEvent: 'APPROVE',
      transitionAt: at(0),
      preStateDigest,
      postStateDigest,
      operation,
    },
    20,
  );
  const follow = event(
    'transition:ALL_PASSED',
    {
      from: intermediate.phase,
      to: after.phase,
      preStateDigest: postStateDigest,
      postStateDigest: digestOf(after),
    },
    50,
  );
  const call = event(
    'tool_call:flowguard_decision',
    {
      tool: 'flowguard_decision',
      success: true,
      transitionCount: 1,
      argsSummary: { sessionID: SESSION, callID: 'call' },
    },
    100,
  );
  const status = event(
    'tool_call:flowguard_status',
    {
      tool: 'flowguard_status',
      success: true,
      transitionCount: 0,
    },
    100,
  );
  const events = sequence(old, transition, receipt, follow, status, call);
  return {
    ...common,
    before,
    after,
    auditBefore: sequence(old),
    events,
    verdict: 'approve',
    rationale: RATIONALE,
    expectedTargetPhase: after.phase as string | undefined,
    expectedDenial: undefined as string | undefined,
    expectedDenialTool: undefined as string | undefined,
    stateDigest: digestOf as unknown,
    receipt: events[2]!,
    transition: events[1]!,
    follow: events[3]!,
    status: events[4]!,
    call: events[5]!,
    operation,
  };
}

function refusal() {
  const run = approval();
  run.after = structuredClone(run.before);
  run.expectedDenial = DENIAL;
  const error = event(`error:${DENIAL}`, { code: DENIAL }, 100);
  const call = event('tool_call:flowguard_decision', {
    tool: 'flowguard_decision',
    success: false,
    transitionCount: 0,
    argsSummary: { sessionID: SESSION, callID: 'call' },
    errorCode: DENIAL,
  });
  run.events = sequence(old, call, error);
  return { ...run, error: run.events[2]!, call: run.events[1]! };
}

describe('decision witness invariants', () => {
  it('links identical receipt and transition pairs once, accepts a distinct follow-up and the closed interval', () => {
    const run = approval();
    run.before.pendingAuditOperations = [{ status: 'reconciled' }];
    run.after.auditOutboxCheckpoint = { auditSequence: 4, chainHash: hash('b') };
    expect(assertNativeDecisionWitness(run)).toEqual(run.events.slice(1));
  });

  it('accepts only the exact refusal interval', () => {
    const run = refusal();
    expect(assertNativeDecisionWitness(run)).toEqual(run.events.slice(1));
  });

  const badApproval: Array<[string, string, (run: ReturnType<typeof approval>) => void]> = [
    [
      'digest function missing',
      'no canonical state-digest authority',
      (run) => {
        run.stateDigest = null;
      },
    ],
    [
      'old authority foreign',
      'lost its pre-dispatch state or audit anchor',
      (run) => {
        run.before.flowguardSessionId = 'fg_old';
      },
    ],
    [
      'old binding foreign',
      'lost its pre-dispatch state or audit anchor',
      (run) => {
        run.before.binding.hostSessionId = 'ses_other';
      },
    ],
    [
      'new binding foreign',
      'lost its pre-dispatch state or audit anchor',
      (run) => {
        run.after.binding.hostSessionId = 'ses_other';
        for (const item of run.events) item.hostSessionId = undefined;
        run.auditBefore[0]!.hostSessionId = undefined;
      },
    ],
    [
      'pending prior audit',
      'lost its pre-dispatch state or audit anchor',
      (run) => {
        run.before.pendingAuditOperations = [{ status: 'pending' }];
      },
    ],
    [
      'pending settled audit',
      'lost its pre-dispatch state or audit anchor',
      (run) => {
        run.after.pendingAuditOperations = [{ status: 'pending' }];
      },
    ],
    [
      'missing checkpoint',
      'audit does not cover the state checkpoint',
      (run) => {
        run.after.auditOutboxCheckpoint = { auditSequence: 99, chainHash: hash() };
      },
    ],
    [
      'false checkpoint',
      'audit does not cover the state checkpoint',
      (run) => {
        run.after.auditOutboxCheckpoint = { auditSequence: 4, chainHash: hash() };
      },
    ],
    [
      'foreign late additional call',
      'foreign or late tool evidence',
      (run) => {
        run.status.occurredAt = at(101);
      },
    ],
    [
      'unbound additional call',
      'foreign or late tool evidence',
      (run) => {
        run.status.hostSessionId = undefined;
      },
    ],
    [
      'empty tool',
      'ambiguous tool evidence',
      (run) => {
        run.status.detail.tool = '';
        run.status.event = 'tool_call:';
      },
    ],
    [
      'tool name mismatch',
      'ambiguous tool evidence',
      (run) => {
        run.status.detail.tool = 'flowguard_plan';
      },
    ],
    [
      'negative transitions',
      'ambiguous tool evidence',
      (run) => {
        run.status.detail.transitionCount = -1;
      },
    ],
    [
      'noninteger transitions',
      'ambiguous tool evidence',
      (run) => {
        run.status.detail.transitionCount = 0.2;
      },
    ],
    [
      'successful tool with error',
      'mixes success with an error code',
      (run) => {
        run.status.detail.errorCode = 'OTHER';
      },
    ],
    [
      'typed contradictory error',
      'contradictory error event',
      (run) => {
        run.events = sequence(...run.events, event('error:OTHER', { code: 'OTHER' }, 100));
      },
    ],
    [
      'failed unrelated tool',
      'unexplained tool failure',
      (run) => {
        run.status.detail.success = false;
        run.status.detail.errorCode = 'OTHER';
      },
    ],
    [
      'call detail label differs',
      'no unique new dispatch-bound tool call',
      (run) => {
        run.call.detail.tool = 'other';
      },
    ],
    [
      'empty call ID',
      'no unique new dispatch-bound tool call',
      (run) => {
        run.call.detail.argsSummary = { sessionID: SESSION, callID: '' };
      },
    ],
    [
      'call with missing host',
      'no unique new dispatch-bound tool call',
      (run) => {
        run.call.hostSessionId = undefined;
      },
    ],
    [
      'negative completion flag',
      'unexplained tool failure',
      (run) => {
        run.call.detail.success = false;
      },
    ],
    [
      'extra tool borrowing the call ID',
      'no unique new dispatch-bound tool call',
      (run) => {
        run.status.detail.argsSummary = { callID: 'call' };
      },
    ],
    [
      'operation for another session',
      'operation-session',
      (run) => {
        run.operation.sessionId = 'ses_other';
      },
    ],
    [
      'operation for another root',
      'operation-root',
      (run) => {
        run.operation.rootSessionId = 'ses_other';
      },
    ],
    [
      'no operation ID',
      'operation-id',
      (run) => {
        run.operation.operationId = '';
      },
    ],
    [
      'invalid authority digest',
      'operation-state-digest-format',
      (run) => {
        run.operation.stateDigest = hash('g');
      },
    ],
    [
      'wrong authority digest',
      'operation-state-digest, operation-pre-digest',
      (run) => {
        run.operation.stateDigest = hash('f');
      },
    ],
    [
      'authority differs from receipt',
      'operation-pre-digest',
      (run) => {
        run.receipt.detail.preStateDigest = hash('f');
      },
    ],
    [
      'receipt post digest invalid',
      'receipt-post-digest-format',
      (run) => {
        run.receipt.detail.postStateDigest = hash('g');
      },
    ],
    [
      'receipt digest unchanged',
      'receipt-no-state-change',
      (run) => {
        run.receipt.detail.postStateDigest = run.receipt.detail.preStateDigest;
      },
    ],
    [
      'receipt denies state change',
      'receipt-state-changed',
      (run) => {
        run.receipt.detail.stateChanged = false;
      },
    ],
    [
      'operation verdict',
      'operation-verdict',
      (run) => {
        run.operation.verdict = 'reject';
      },
    ],
    [
      'receipt verdict',
      'receipt-verdict',
      (run) => {
        run.receipt.detail.verdict = 'reject';
      },
    ],
    [
      'receipt rationale',
      'receipt-rationale]',
      (run) => {
        run.receipt.detail.rationale = 'different';
      },
    ],
    [
      'receipt from phase',
      'receipt-from-phase',
      (run) => {
        run.receipt.detail.fromPhase = 'TICKET';
      },
    ],
    [
      'receipt foreign host',
      'receipt-host-session',
      (run) => {
        run.receipt.hostSessionId = undefined;
      },
    ],
    [
      'receipt after interval',
      'receipt-dispatch',
      (run) => {
        run.receipt.occurredAt = at(101);
      },
    ],
    [
      'target not provided',
      'target-missing, after-phase',
      (run) => {
        run.expectedTargetPhase = undefined;
      },
    ],
    [
      'after phase wrong',
      'after-phase',
      (run) => {
        run.after.phase = 'READY';
      },
    ],
    [
      'first transition from phase',
      'transition-from',
      (run) => {
        run.transition.detail.from = 'READY';
      },
    ],
    [
      'first transition to phase',
      'transition-to',
      (run) => {
        run.receipt.detail.toPhase = 'READY';
      },
    ],
    [
      'first transition name',
      'transition-event',
      (run) => {
        run.transition.event = 'transition:OTHER';
      },
    ],
    [
      'first transition instant',
      'transition-time',
      (run) => {
        run.receipt.detail.transitionAt = at(1);
      },
    ],
    [
      'first transition pre-digest',
      'transition-pre-digest',
      (run) => {
        run.transition.detail.preStateDigest = hash('f');
      },
    ],
    [
      'first transition post-digest',
      'transition-post-digest',
      (run) => {
        run.transition.detail.postStateDigest = hash('f');
      },
    ],
    [
      'transition phase discontinuity',
      'transition-chain',
      (run) => {
        run.follow.detail.from = 'READY';
      },
    ],
    [
      'transition missing host',
      'transition-chain',
      (run) => {
        run.follow.hostSessionId = undefined;
      },
    ],
    [
      'transition outside interval',
      'transition-chain',
      (run) => {
        run.follow.occurredAt = at(-1);
      },
    ],
    [
      'transition wrong target',
      'transition-target, transition-target-count',
      (run) => {
        run.follow.detail.to = 'READY';
      },
    ],
    [
      'transition target appears twice',
      'transition-target-count',
      (run) => {
        run.follow.detail.from =
          run.transition.detail.to =
          run.receipt.detail.toPhase =
            'IMPLEMENTATION';
      },
    ],
    [
      'extra stale state write with valid digests',
      'native state chain contains foreign or late evidence',
      (run) => {
        run.events = sequence(...run.events, event('state_write', run.follow.detail, 101));
      },
    ],
    [
      'extra unbound state write with valid digests',
      'native state chain contains foreign or late evidence',
      (run) => {
        run.events = sequence(...run.events, {
          ...event('state_write', run.follow.detail),
          hostSessionId: undefined,
        });
      },
    ],
    [
      'bad settled digest',
      'state-digest chain does not reach the settled state',
      (run) => {
        run.follow.detail.postStateDigest = hash('f');
      },
    ],
    [
      'right pre-digest but wrong repeated pair',
      'state-digest chain is discontinuous',
      (run) => {
        run.events = sequence(
          ...run.events,
          event('state_write', { ...run.follow.detail, postStateDigest: hash('f') }, 100),
        );
      },
    ],
    [
      'right post-digest but wrong repeated pair',
      'state-digest chain is discontinuous',
      (run) => {
        run.events = sequence(
          ...run.events,
          event('state_write', { ...run.follow.detail, preStateDigest: hash('f') }, 100),
        );
      },
    ],
  ];
  it.each(badApproval)('rejects a native approval with %s', (_name, message, change) => {
    const run = approval();
    change(run);
    expect(() => assertNativeDecisionWitness(run)).toThrow(message);
  });

  const badRefusal: Array<[string, string, (run: ReturnType<typeof refusal>) => void]> = [
    [
      'separate successful tool',
      'closing error witness',
      (run) => {
        run.events = sequence(old, run.call, run.status, run.error);
      },
    ],
    [
      'two matching errors',
      'closing error witness',
      (run) => {
        run.events = sequence(old, run.call, run.error, run.error);
      },
    ],
    [
      'matching error with wrong label',
      'closing error witness',
      (run) => {
        run.error.event = 'error:OTHER';
      },
    ],
    [
      'wrong attempted tool',
      'unexplained tool failure',
      (run) => {
        run.expectedDenialTool = 'flowguard_status';
      },
    ],
    [
      'state changed despite refusal',
      'native refusal changed persisted session state',
      (run) => {
        run.after.phase = 'READY';
      },
    ],
    [
      'foreign closing error',
      'foreign or late tool evidence',
      (run) => {
        run.error.hostSessionId = undefined;
      },
    ],
    [
      'late closing error',
      'foreign or late tool evidence',
      (run) => {
        run.error.occurredAt = at(101);
      },
    ],
  ];
  it.each(badRefusal)('rejects a native refusal with %s', (_name, message, change) => {
    const run = refusal();
    change(run);
    expect(() => assertNativeDecisionWitness(run)).toThrow(message);
  });
});
