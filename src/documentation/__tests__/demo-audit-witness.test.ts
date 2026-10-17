/** Real-file, runner-level regressions for audit-bound demo recovery witnesses. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runner } from '../../../demos/java-task-manager/run-live-matrix.mjs';
import {
  assertHumanDecisionRefusalUnchanged,
  readAuditEvents,
} from '../../../demos/lib/recovery-state.mjs';
import { hashText } from '../../shared/hashing.js';

const SESSION = 'ses_parent';
const FLOWGUARD_SESSION = '11111111-1111-4111-8111-111111111111';
const CALL = 'call_refused_decision';
const START = Date.parse('2026-10-17T09:45:54.535Z');
const END = START + 118;
let root: string;
let sessionDir: string;
let auditFile: string;
let runner: Runner;

function event(sequence: number, name: string, detail: Record<string, unknown>, at = START - 1000) {
  return {
    auditSequence: sequence,
    flowguardSessionId: FLOWGUARD_SESSION,
    hostSessionId: SESSION,
    occurredAt: new Date(at).toISOString(),
    event: name,
    detail,
  };
}

const before = event(1, 'tool_call:flowguard_status', { tool: 'flowguard_status', success: true });
function refused(sequence = 2) {
  return event(
    sequence,
    'tool_call:flowguard_decision',
    {
      tool: 'flowguard_decision',
      argsSummary: { sessionID: SESSION, callID: CALL },
      success: false,
      errorCode: 'HUMAN_DECISION_REQUIRED',
      transitionCount: 0,
    },
    END - 8,
  );
}

async function writeAudit(events: unknown[]) {
  await fs.writeFile(auditFile, events.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function hostResult(stdout: string) {
  return { stdout, code: 0, stderr: '', timedOut: false, durationMs: 1, sessionIds: [SESSION] };
}

function refusalTranscript() {
  return JSON.stringify({
    type: 'tool_use',
    sessionID: SESSION,
    timestamp: END + 1,
    part: {
      tool: 'flowguard_decision',
      callID: CALL,
      state: {
        time: { start: START, end: END },
        output: JSON.stringify({ error: true, code: 'HUMAN_DECISION_REQUIRED' }),
      },
    },
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-demo-audit-witness-'));
  sessionDir = path.join(root, 'config', 'workspaces', 'fixture', 'sessions', SESSION);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(path.join(root, 'evidence'));
  auditFile = path.join(sessionDir, 'audit.jsonl');
  await fs.writeFile(
    path.join(sessionDir, 'session-state.json'),
    JSON.stringify({
      phase: 'ARCH_REVIEW',
      flowguardSessionId: FLOWGUARD_SESSION,
      binding: { hostSessionId: SESSION, worktree: root },
      architecture: { reviewCompletion: 'review_exhausted', status: 'proposed' },
    }),
  );
  await writeAudit([before]);
  runner = new Runner(root, { model: 'test/model', flows: [] }, path.join(root, 'config'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('audit-backed human-decision refusal', () => {
  function turn() {
    return runner.turn(
      { sessionId: SESSION, workspace: root, terminal: 'ARCH_COMPLETE' },
      'architecture-negative-03-recovery',
      '/architecture',
    );
  }

  it('continues after the exact audited, non-mutating refused decision call', async () => {
    vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
      await writeAudit([before, refused()]);
      return hostResult(refusalTranscript());
    });
    const session: {
      sessionId: string;
      workspace: string;
      terminal: string;
      governedRefusals?: unknown[];
    } = {
      sessionId: SESSION,
      workspace: root,
      terminal: 'ARCH_COMPLETE',
    };
    await runner.turn(session, 'architecture-negative-03-recovery', '/architecture');
    expect(session.governedRefusals).toEqual([
      {
        step: 'architecture-negative-03-recovery',
        code: 'HUMAN_DECISION_REQUIRED',
        callId: CALL,
        evidence: 'audit_no_refused_call_mutation',
      },
    ]);
  });

  it.each(['missing', 'empty', 'truncated', 'non-object'] as const)(
    'cannot credit a refusal when the post-turn audit is %s',
    async (kind) => {
      vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
        if (kind === 'missing') await fs.rm(auditFile);
        else
          await fs.writeFile(
            auditFile,
            { empty: '', truncated: '{truncated', 'non-object': 'null\n' }[kind],
          );
        return hostResult(refusalTranscript());
      });
      await expect(turn()).rejects.toMatchObject({ code: 'DEMO_NOT_VERIFIED' });
    },
  );

  it.each([
    'wrong-call',
    'foreign-session',
    'foreign-host',
    'historical',
    'future',
    'missing-time',
    'gap',
    'no-refusal',
    'wrong-tool',
    'success',
    'transition-count',
  ] as const)('requires a current, session-bound audit witness (%s)', async (kind) => {
    vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
      const denial = refused();
      if (kind === 'wrong-call')
        denial.detail.argsSummary = { sessionID: SESSION, callID: 'call_other' };
      if (kind === 'foreign-session') denial.flowguardSessionId = 'fg-other';
      if (kind === 'foreign-host') denial.hostSessionId = 'ses_foreign';
      if (kind === 'historical') denial.occurredAt = new Date(START - 500).toISOString();
      if (kind === 'future') denial.occurredAt = new Date(END + 1).toISOString();
      if (kind === 'missing-time') denial.occurredAt = '';
      if (kind === 'gap') denial.auditSequence = 3;
      if (kind === 'wrong-tool') denial.detail.tool = 'flowguard_plan';
      if (kind === 'success') denial.detail.success = true;
      if (kind === 'transition-count') denial.detail.transitionCount = 1;
      await writeAudit(kind === 'no-refusal' ? [before] : [before, denial]);
      return hostResult(refusalTranscript());
    });
    await expect(turn()).rejects.toMatchObject({ code: 'DEMO_NOT_VERIFIED' });
  });

  it.each(['state_write', 'transition:ARCHITECTURE_APPROVED'])(
    'does not overlook %s before tool completion',
    async (name) => {
      vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
        await writeAudit([before, event(2, name, {}, START + 30), refused(3)]);
        return hostResult(refusalTranscript());
      });
      await expect(turn()).rejects.toThrow(/HUMAN_DECISION_REQUIRED/);
    },
  );

  it('allows earlier review progress in the turn, outside the refused call interval', async () => {
    vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
      await writeAudit([before, event(2, 'transition:SELF_REVIEW_MET', {}, START - 1), refused(3)]);
      return hostResult(refusalTranscript());
    });
    await expect(turn()).resolves.toMatchObject({ code: 0 });
  });

  it.each(['missing-call', 'missing-start', 'invalid-end', 'reversed-interval'] as const)(
    'cannot prove a refusal with ambiguous host metadata (%s)',
    async (kind) => {
      vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
        await writeAudit([before, refused()]);
        const value = JSON.parse(refusalTranscript());
        if (kind === 'missing-call') delete value.part.callID;
        if (kind === 'missing-start') delete value.part.state.time.start;
        if (kind === 'invalid-end') value.part.state.time.end = 'unavailable';
        if (kind === 'reversed-interval') value.part.state.time.end = START - 1;
        return hostResult(JSON.stringify(value));
      });
      await expect(turn()).rejects.toMatchObject({ code: 'DEMO_NOT_VERIFIED' });
    },
  );

  it('does not let one audited refusal excuse a later unaudited occurrence', async () => {
    vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
      await writeAudit([before, refused()]);
      const second = JSON.parse(refusalTranscript());
      second.part.callID = 'call_second_decision';
      return hostResult(`${refusalTranscript()}\n${JSON.stringify(second)}`);
    });
    await expect(turn()).rejects.toMatchObject({ code: 'DEMO_NOT_VERIFIED' });
  });

  it('does not accept a refusal emitted by a different governed tool', async () => {
    vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
      await writeAudit([before, refused()]);
      const value = JSON.parse(refusalTranscript());
      value.part.tool = 'flowguard_plan';
      return hostResult(JSON.stringify(value));
    });
    await expect(turn()).rejects.toThrow(/unexpected tool-level block/);
  });

  it('never excuses another decision error with an unrelated HUMAN_DECISION_REQUIRED audit entry', async () => {
    vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
      await writeAudit([before, refused()]);
      const value = JSON.parse(refusalTranscript());
      value.part.state.output = JSON.stringify({ error: true, code: 'FOUR_EYES_ACTOR_MATCH' });
      return hostResult(JSON.stringify(value));
    });
    await expect(turn()).rejects.toThrow(/FOUR_EYES_ACTOR_MATCH/);
  });

  it('rejects a mutation after the refusal even when its occurrence time is backdated', async () => {
    vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
      await writeAudit([before, refused(), event(3, 'state_write', {}, START - 1)]);
      return hostResult(refusalTranscript());
    });
    await expect(turn()).rejects.toThrow(/HUMAN_DECISION_REQUIRED/);
  });

  it('never lets a terminal phase override a witnessed decision-call mutation', async () => {
    vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
      const stateFile = path.join(sessionDir, 'session-state.json');
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      state.phase = 'ARCH_COMPLETE';
      await fs.writeFile(stateFile, JSON.stringify(state));
      await writeAudit([
        before,
        event(2, 'transition:ARCHITECTURE_APPROVED', {}, START + 30),
        refused(3),
      ]);
      return hostResult(refusalTranscript());
    });
    await expect(turn()).rejects.toMatchObject({ code: 'DEMO_REFUSED_DECISION_MUTATION' });
  });

  it('does not start another host turn when the required pre-turn audit is unavailable', async () => {
    await fs.rm(auditFile);
    const host = vi
      .spyOn(runner, 'hostStep')
      .mockRejectedValue(new Error('unexpected host execution'));
    await expect(turn()).rejects.toMatchObject({ code: 'DEMO_NOT_VERIFIED' });
    expect(host).not.toHaveBeenCalled();
  });

  it('does not silently parse an unavailable audit as an empty history', async () => {
    await fs.rm(auditFile);
    expect(() => readAuditEvents(sessionDir)).toThrow(/audit/i);
  });
});

describe('explicit audit witness boundary', () => {
  const state = { flowguardSessionId: FLOWGUARD_SESSION, binding: { hostSessionId: SESSION } };
  const call = { tool: 'flowguard_decision', callId: CALL, startedAt: START, at: END };

  it.each(['', '\n\t\n', 'null\n', '42\n', '[]\n', '"text"\n'])(
    'surfaces empty or non-object audit input directly (%j)',
    async (content) => {
      await fs.writeFile(auditFile, content);
      expect(() => readAuditEvents(sessionDir)).toThrow(/must contain event objects/);
    },
  );

  it('permits blank JSONL separators between actual audit events', async () => {
    await fs.writeFile(auditFile, `\n \t\n${JSON.stringify(before)}\n\n`);
    expect(readAuditEvents(sessionDir)).toEqual([before]);
  });

  it('never drops a malformed row from an otherwise nonempty audit', async () => {
    await writeAudit([before, null, refused(3)]);
    expect(() => readAuditEvents(sessionDir)).toThrow(/must contain event objects/);
  });

  it.each([
    { state: undefined },
    { state: {} },
    { state: { ...state, flowguardSessionId: '' } },
    { state: { ...state, flowguardSessionId: 1 } },
    { state: { flowguardSessionId: FLOWGUARD_SESSION } },
    { state: { ...state, binding: { hostSessionId: '' } } },
    { state: { ...state, binding: { hostSessionId: 1 } } },
  ])('rejects an unbound actor before inspecting audit contents (%j)', ({ state: actor }) => {
    expect(() => assertHumanDecisionRefusalUnchanged(actor, call, 1, [before, refused()])).toThrow(
      /bound decision-call interval/,
    );
  });

  it.each([
    undefined,
    { ...call, tool: 'flowguard_plan' },
    { ...call, callId: '' },
    { ...call, callId: 1 },
    { ...call, startedAt: NaN },
    { ...call, at: NaN },
    { ...call, startedAt: -1 },
    { ...call, at: START - 1 },
  ])('rejects unusable host call metadata at the call boundary (%j)', (input) => {
    expect(() => assertHumanDecisionRefusalUnchanged(state, input, 1, [before, refused()])).toThrow(
      /bound decision-call interval/,
    );
  });

  it.each([-1, NaN, 0.5])('rejects an unavailable pre-turn audit floor (%s)', (floor) => {
    expect(() =>
      assertHumanDecisionRefusalUnchanged(state, call, floor, [before, refused()]),
    ).toThrow(/bound decision-call interval/);
  });

  it.each([
    null,
    { ...before, detail: [] },
    { ...before, detail: null },
    { ...before, detail: 1 },
    { ...before, event: 1 },
    { ...before, occurredAt: 0 },
    { ...before, occurredAt: 'not-a-date' },
  ])('rejects malformed audit projections rather than skipping rows (%j)', (entry) => {
    expect(() => assertHumanDecisionRefusalUnchanged(state, call, 1, [entry, refused()])).toThrow(
      /complete session-bound audit window/,
    );
  });

  it.each([{ events: [] }, { events: [before] }])(
    'requires an appended current-turn audit window (%j)',
    ({ events }) => {
      expect(() => assertHumanDecisionRefusalUnchanged(state, call, 1, events)).toThrow(
        /complete session-bound audit window/,
      );
    },
  );

  it('permits canonical earlier events without optional host binding', () => {
    const { hostSessionId: _host, ...semantic } = before;
    expect(() =>
      assertHumanDecisionRefusalUnchanged(state, call, 1, [semantic, refused()]),
    ).not.toThrow();
  });

  it.each([
    { event: 'error:HUMAN_DECISION_REQUIRED' },
    { hostSessionId: undefined },
    { detail: { ...refused().detail, errorCode: 'OTHER' } },
    { detail: { ...refused().detail, argsSummary: {} } },
    { detail: { ...refused().detail, argsSummary: { sessionID: 'ses_other', callID: CALL } } },
  ])('requires the exact failed tool-call record (%j)', (override) => {
    expect(() =>
      assertHumanDecisionRefusalUnchanged(state, call, 1, [before, { ...refused(), ...override }]),
    ).toThrow(/unique current-call audit refusal/);
  });

  it('rejects duplicate audit refusals for the same host call', () => {
    expect(() =>
      assertHumanDecisionRefusalUnchanged(state, call, 1, [before, refused(), refused(3)]),
    ).toThrow(/unique current-call audit refusal/);
  });

  it('does not re-use a refusal from at or before the pre-turn audit floor', () => {
    const events = [before, refused(), event(3, 'tool_call:flowguard_status', { success: true })];
    expect(() => assertHumanDecisionRefusalUnchanged(state, call, 2, events)).toThrow(
      /unique current-call audit refusal/,
    );
  });

  it('ignores writes already included in the pre-turn floor even at the same clock millisecond', () => {
    expect(() =>
      assertHumanDecisionRefusalUnchanged(state, call, 1, [
        event(1, 'state_write', {}, START),
        refused(),
      ]),
    ).not.toThrow();
  });

  it.each([START, END])('accepts audit timestamps exactly at the call boundary (%s)', (at) => {
    expect(() =>
      assertHumanDecisionRefusalUnchanged(state, call, 1, [
        before,
        {
          ...refused(),
          occurredAt: new Date(at).toISOString(),
        },
      ]),
    ).not.toThrow();
  });

  it('accepts a first-turn refusal and a zero-duration host call', () => {
    expect(() =>
      assertHumanDecisionRefusalUnchanged(
        state,
        {
          ...call,
          startedAt: 0,
          at: 0,
        },
        0,
        [{ ...refused(1), occurredAt: new Date(0).toISOString() }],
      ),
    ).not.toThrow();
  });

  it('detects a write exactly at call start', () => {
    expect(() =>
      assertHumanDecisionRefusalUnchanged(state, call, 1, [
        before,
        event(2, 'state_write', {}, START),
        refused(3),
      ]),
    ).toThrow(/persisted mutation/);
  });
});

describe('ticket conflict recovery through the real runner', () => {
  it.each(['TICKET_SOURCE_CONFLICT', 'TICKET_SOURCE_ORIGIN_CONFLICT'])(
    'settles %s in the adoption turn and permits the subsequent plan turn',
    async (code) => {
      const stateFile = path.join(sessionDir, 'session-state.json');
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      state.phase = 'READY';
      state.architecture = null;
      await fs.writeFile(stateFile, JSON.stringify(state));
      const text = '# Task\nAdopt the real ticket from TICKET.md.';
      let turns = 0;
      vi.spyOn(runner, 'hostStep').mockImplementation(async () => {
        turns += 1;
        if (turns === 2) {
          state.phase = 'PLAN';
          await fs.writeFile(stateFile, JSON.stringify(state));
          return hostResult(
            JSON.stringify({
              type: 'tool_use',
              part: {
                tool: 'flowguard_plan',
                state: { output: JSON.stringify({ phase: 'PLAN' }) },
              },
            }),
          );
        }
        state.phase = 'TICKET';
        state.ticket = { digest: hashText(text), text, source: 'user' };
        await fs.writeFile(stateFile, JSON.stringify(state));
        await writeAudit([
          before,
          event(2, 'tool_call:flowguard_ticket', {
            tool: 'flowguard_ticket',
            success: false,
            errorCode: code,
          }),
          event(3, 'tool_call:flowguard_ticket', {
            tool: 'flowguard_ticket',
            success: true,
            transitionCount: 1,
          }),
          event(4, 'transition:TICKET_SELECTED', {
            from: 'READY',
            to: 'TICKET',
            event: 'TICKET_SELECTED',
          }),
        ]);
        return hostResult(
          [{ error: true, code }, { phase: 'TICKET' }]
            .map((output) =>
              JSON.stringify({
                type: 'tool_use',
                part: {
                  tool: 'flowguard_ticket',
                  state: { output: JSON.stringify(output) },
                },
              }),
            )
            .join('\n'),
        );
      });
      const session: {
        sessionId: string;
        workspace: string;
        terminal: string;
        awaitingRecovery?: unknown;
        recoveredDenials?: unknown[];
      } = { sessionId: SESSION, workspace: root, terminal: 'COMPLETE' };
      await runner.turn(session, 'development-02-task', '/task --file TICKET.md');
      expect(session.awaitingRecovery).toBeUndefined();
      expect(session.recoveredDenials).toContainEqual(
        expect.objectContaining({
          status: 'proven',
          codes: [code],
          evidence: 'ticket_adoption',
        }),
      );
      await expect(runner.turn(session, 'development-03-plan', '/plan')).resolves.toMatchObject({
        code: 0,
      });
    },
  );
});
