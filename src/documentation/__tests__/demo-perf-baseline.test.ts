/**
 * @module documentation/demo-perf-baseline.test
 * @description The read-only latency baseline analyzer over archived live-run
 * roots: per-occurrence denial classification, causal attribution only when a
 * recovery is reconstructable, observed-only phases, explicit NOT_OBSERVED for
 * missing evidence, p95 sample tiers, and no content in the output.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE - all four categories present.
 * @version v1
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FOLLOWUP_PROMPT_SENTINEL,
  NOT_OBSERVED,
  analyzeRunRoot,
  analyzeTurnDenials,
  classifyDenial,
  assertOutsideRoots,
  buildReport,
  describeSample,
  parseDriverLog,
  renderMarkdown,
  summarize,
} from '../../../demos/lib/perf-baseline.mjs';

const SECRET_PROMPT = 'SECRET-PROMPT-CONTENT do not leak';
const SECRET_CODE = 'SECRET-REPOSITORY-CONTENT class Leak {}';
const PARENT = 'ses_parent_dev';
const CHILD = 'ses_child_review';
const CHILD_NO_FOLLOWUP = 'ses_child_task_only';
const NEGATIVE = 'ses_parent_negative';

type Json = Record<string, unknown>;

function toolUse(tool: string, payload: Json | string): Json {
  return {
    type: 'tool_use',
    sessionID: PARENT,
    part: {
      tool,
      state: { output: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    },
  };
}

const STEP = { type: 'step_start', sessionID: PARENT };

function denial(code: string): Json {
  return { error: true, code, reason: SECRET_CODE };
}

function jsonl(events: readonly Json[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function message(
  sessionID: string,
  role: 'user' | 'assistant',
  extra: Json = {},
  parts: readonly Json[] = [],
): Json {
  return {
    info: { id: `${sessionID}-${role}-${Math.random()}`, sessionID, role, ...extra },
    parts,
  };
}

function assistant(sessionID: string, created: number, completed: number, extra: Json = {}): Json {
  return message(sessionID, 'assistant', {
    time: { created, completed },
    tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 7 } },
    ...extra,
  });
}

function userText(sessionID: string, text: string): Json {
  return message(sessionID, 'user', { time: { created: 0 } }, [{ type: 'text', text }]);
}

let root: string;

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeFixtureRoot(): void {
  write(
    'evidence/metadata.json',
    JSON.stringify({
      model: 'provider/model-x',
      pins: { opencode: '1.19.0' },
      checkoutHead: 'abc',
    }),
  );
  write(
    'evidence/flows.json',
    JSON.stringify([
      {
        name: 'development',
        result: 'COMPLETE',
        hostSessionId: PARENT,
        installedBuild: { gitSha: 'feedbeefcafe0000' },
        recoveredDenials: [
          {
            status: 'proven',
            step: 'development-03-implement',
            codes: ['INVALID_IMPLEMENT_TOOL_SEQUENCE'],
            denials: [
              { index: 1, code: 'INVALID_IMPLEMENT_TOOL_SEQUENCE', tool: 'flowguard_implement' },
            ],
            evidence: 'next_step_operation_transition:development-04-validate',
          },
        ],
      },
      { name: 'architecture-negative', result: 'CONTROL_PASSED', hostSessionId: NEGATIVE },
    ]),
  );
  write(
    'evidence/driver.log',
    [
      '2026-10-13T10:00:00.000Z development-01-start: exit=0 time=12s',
      '2026-10-13T10:01:00.000Z development-02-plan: exit=0 time=95s',
      '2026-10-13T10:03:00.000Z development-03-implement: exit=0 time=40s',
      '2026-10-13T10:04:00.000Z development-04-validate: exit=0 time=30s',
      '2026-10-13T10:05:00.000Z architecture-negative-01-adr: exit=0 time=20s',
      '',
    ].join('\n'),
  );
  write(
    'evidence/development-01-start.jsonl',
    jsonl([STEP, toolUse('flowguard_status', { phase: 'READY' })]),
  );
  // Same-turn recovery: denial, one model step, then the corrected call succeeds.
  write(
    'evidence/development-02-plan.jsonl',
    jsonl([
      STEP,
      toolUse('flowguard_status', { phase: 'PLAN' }),
      toolUse('flowguard_plan', {
        ...denial('INVALID_PLAN_TOOL_SEQUENCE'),
        subjectDigest: 'plan-a',
      }),
      STEP,
      toolUse('flowguard_plan', { phase: 'PLAN_REVIEW', subjectDigest: 'plan-a' }),
    ]),
  );
  // No step events at all; the denial is recovered only by the runner's next step.
  write(
    'evidence/development-03-implement.jsonl',
    jsonl([toolUse('flowguard_implement', denial('INVALID_IMPLEMENT_TOOL_SEQUENCE'))]),
  );
  // Two denials of the same tool share one later success: the first is ambiguous.
  write(
    'evidence/development-04-validate.jsonl',
    jsonl([
      STEP,
      toolUse('flowguard_run_check', denial('WRONG_PHASE')),
      toolUse('flowguard_run_check', denial('COMMAND_NOT_ALLOWED')),
      STEP,
      toolUse('flowguard_run_check', { phase: 'IMPL_REVIEW' }),
    ]),
  );
  write(
    'evidence/architecture-negative-01-adr.jsonl',
    jsonl([STEP, toolUse('flowguard_architecture', denial('WRONG_PHASE'))]),
  );
  write(
    `evidence/development-host-${PARENT}.json`,
    JSON.stringify({
      info: { id: PARENT },
      messages: [userText(PARENT, SECRET_PROMPT), assistant(PARENT, 1000, 4000)],
    }),
  );
  write(
    `evidence/development-host-${CHILD}.json`,
    JSON.stringify({
      info: { id: CHILD, parentID: PARENT },
      messages: [
        userText(CHILD, SECRET_PROMPT),
        assistant(CHILD, 10_000, 70_000),
        userText(CHILD, `${FOLLOWUP_PROMPT_SENTINEL}\n${SECRET_PROMPT}`),
        assistant(CHILD, 71_000, 80_000, {
          structured: { overallVerdict: 'changes_requested', summary: SECRET_CODE },
        }),
      ],
    }),
  );
  write(
    `evidence/development-host-${CHILD_NO_FOLLOWUP}.json`,
    JSON.stringify({
      info: { id: CHILD_NO_FOLLOWUP, parentID: PARENT },
      messages: [userText(CHILD_NO_FOLLOWUP, SECRET_PROMPT), assistant(CHILD_NO_FOLLOWUP, 0, 5)],
    }),
  );
  write(
    'workspaces/java-task-manager/.opencode/logs/flowguard-2026-10-13.log',
    [
      { message: 'tool.execute.after', sessionId: PARENT, extra: { beforeToAfterMs: 120.5 } },
      {
        message: 'tool.execute.after',
        sessionId: PARENT,
        extra: { durationUnavailable: 'start_not_observed' },
      },
      {
        message: 'review structured followup timing',
        extra: { childSessionId: CHILD, followupPromptMs: 9000 },
      },
      { message: 'unrelated', sessionId: PARENT, extra: { beforeToAfterMs: 999 } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  const recordsFile = path.join(root, 'evidence/flows.json');
  const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
  const refs = [PARENT, CHILD, CHILD_NO_FOLLOWUP].map((sessionId) => {
    const file = `development-host-${sessionId}.json`;
    return {
      sessionId,
      file,
      sha256: createHash('sha256')
        .update(fs.readFileSync(path.join(root, 'evidence', file)))
        .digest('hex'),
    };
  });
  records[0].transcripts = { parent: refs[0], reviewers: refs.slice(1) };
  fs.writeFileSync(recordsFile, JSON.stringify(records));
}

function flow(name: string) {
  const found = analyzeRunRoot(root).find((candidate) => candidate.flow === name);
  expect(found, name).toBeDefined();
  return found!;
}

function turn(flowName: string, step: string) {
  const found = flow(flowName).turns.find((candidate) => candidate.step === step);
  expect(found, step).toBeDefined();
  return found!;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-perf-baseline-'));
  writeFixtureRoot();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('demo perf baseline - denial attribution', () => {
  it('HAPPY: attributes a same-turn recovery with its extra model steps and calls', () => {
    const [denied] = turn('development', 'development-02-plan').denials;
    expect(denied).toMatchObject({
      code: 'INVALID_PLAN_TOOL_SEQUENCE',
      class: 'avoidable_call_shape',
      phase: 'PLAN',
      recovery: 'same_turn',
      attribution: 'attributed',
      extraModelSteps: 1,
      extraToolCalls: 1,
      extraHostTurns: 0,
    });
  });

  it('HAPPY: attributes a runner-proven next-step recovery as one extra host turn', () => {
    const [denied] = turn('development', 'development-03-implement').denials;
    expect(denied).toMatchObject({
      recovery: 'next_turn',
      attribution: 'attributed',
      extraHostTurns: 1,
      extraModelSteps: NOT_OBSERVED,
    });
  });

  it('BAD: a later success shared by two denials of the same tool is not attributed', () => {
    const [first, second] = turn('development', 'development-04-validate').denials;
    expect(first).toMatchObject({ code: 'WRONG_PHASE', attribution: NOT_OBSERVED });
    expect(second).toMatchObject({ code: 'COMMAND_NOT_ALLOWED', attribution: NOT_OBSERVED });
  });

  it('does not attribute tool-only success or success for another operation', () => {
    write(
      'evidence/development-02-plan.jsonl',
      jsonl([
        toolUse('flowguard_plan', {
          ...denial('INVALID_PLAN_TOOL_SEQUENCE'),
          subjectDigest: 'plan-a',
        }),
        toolUse('flowguard_plan', { phase: 'PLAN_REVIEW', subjectDigest: 'plan-b' }),
      ]),
    );
    expect(turn('development', 'development-02-plan').denials[0]).toMatchObject({
      attribution: NOT_OBSERVED,
    });
  });

  it('never credits a pending observation as a next-step proof', () => {
    const file = path.join(root, 'evidence/flows.json');
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    records[0].recoveredDenials[0].status = 'pending_verification';
    fs.writeFileSync(file, JSON.stringify(records));
    expect(turn('development', 'development-03-implement').denials[0]).toMatchObject({
      attribution: NOT_OBSERVED,
    });
  });

  it('charges overlapping operation-recovery spans only once', () => {
    const denials = analyzeTurnDenials({
      output: jsonl([
        toolUse('flowguard_plan', { ...denial('WRONG_PHASE'), subjectDigest: 'plan-a' }),
        toolUse('flowguard_architecture', { ...denial('WRONG_PHASE'), subjectDigest: 'adr-a' }),
        STEP,
        toolUse('flowguard_plan', { subjectDigest: 'plan-a' }),
        toolUse('flowguard_architecture', { subjectDigest: 'adr-a' }),
      ]),
      flow: 'development',
      step: 'shared',
      record: undefined,
    });
    expect(denials).toMatchObject([
      { extraToolCalls: 2, extraModelSteps: 1 },
      { extraToolCalls: 1, extraModelSteps: 0 },
    ]);
  });

  it('charges a shared proven recovery turn once across denial occurrences', () => {
    const record = {
      recoveredDenials: [
        {
          status: 'proven',
          step: 'shared',
          codes: ['WRONG_PHASE'],
          evidence: 'next_step_operation_transition:approve',
          denials: [1, 2].map((index) => ({ index, code: 'WRONG_PHASE', tool: 'flowguard_plan' })),
        },
      ],
    };
    const denials = analyzeTurnDenials({
      output: jsonl([
        toolUse('flowguard_plan', denial('WRONG_PHASE')),
        toolUse('flowguard_plan', denial('WRONG_PHASE')),
      ]),
      flow: 'development',
      step: 'shared',
      record,
    });
    expect(denials).toMatchObject([{ extraHostTurns: 1 }, { extraHostTurns: 0 }]);
    record.recoveredDenials[0]!.denials[1]!.index = 99;
    expect(
      analyzeTurnDenials({
        output: jsonl([
          toolUse('flowguard_plan', denial('WRONG_PHASE')),
          toolUse('flowguard_plan', denial('WRONG_PHASE')),
        ]),
        flow: 'development',
        step: 'shared',
        record,
      })[1],
    ).toMatchObject({ attribution: NOT_OBSERVED });
  });

  it('BAD: an unrecovered denial never gains an attributed follow-up cost', () => {
    const [denied] = turn('architecture-negative', 'architecture-negative-01-adr').denials;
    expect(denied).toMatchObject({ recovery: NOT_OBSERVED, attribution: NOT_OBSERVED });
    expect(denied).not.toHaveProperty('extraHostTurns');
  });

  it('CORNER: outside a declared control step the code class decides, even in the negative flow', () => {
    expect(turn('architecture-negative', 'architecture-negative-01-adr').denials[0]).toMatchObject({
      code: 'WRONG_PHASE',
      class: 'avoidable_call_shape',
    });
    expect(turn('development', 'development-04-validate').denials[0]).toMatchObject({
      code: 'WRONG_PHASE',
      class: 'avoidable_call_shape',
    });
  });

  it('BAD: a control step declares ONE expected code; another denial there is a real defect', () => {
    expect(
      classifyDenial({
        code: 'WRONG_PHASE',
        flow: 'architecture-negative',
        step: 'architecture-negative-02-probe',
      }),
    ).toBe('avoidable_call_shape');
    expect(
      classifyDenial({
        code: 'WRONG_PHASE',
        flow: 'architecture-negative',
        step: 'architecture-negative-04-approve',
      }),
    ).toBe('avoidable_call_shape');
    expect(
      classifyDenial({
        code: 'GOVERNANCE_OVERRIDE_REQUIRED',
        flow: 'architecture-negative',
        step: 'architecture-negative-02-probe',
      }),
    ).toBe('unexpected');
  });

  it('HAPPY: only the declared (step, code) pair is a controlled negative', () => {
    expect(
      classifyDenial({
        code: 'ARCHITECTURE_CLAIM_INVALID',
        flow: 'architecture-negative',
        step: 'architecture-negative-02-probe',
      }),
    ).toBe('controlled_negative');
    expect(
      classifyDenial({
        code: 'GOVERNANCE_OVERRIDE_REQUIRED',
        flow: 'architecture-negative',
        step: 'architecture-negative-04-approve',
      }),
    ).toBe('controlled_negative');
  });

  it('EDGE: phases and model steps are never guessed', () => {
    const implement = turn('development', 'development-03-implement');
    expect(implement.denials[0]?.phase).toBe(NOT_OBSERVED);
    expect(implement.phaseObserved).toBe(NOT_OBSERVED);
    expect(implement.modelSteps).toBe(NOT_OBSERVED);
    expect(turn('development', 'development-02-plan').phaseObserved).toBe('PLAN_REVIEW');
  });
});

describe('demo perf baseline - durations, exports and runtime logs', () => {
  it('HAPPY: uses driver-log seconds and labels the duration source', () => {
    const plan = turn('development', 'development-02-plan');
    expect(plan).toMatchObject({ durationMs: 95_000, durationSource: 'driver_log_seconds' });
    expect(flow('development').flowDurationMs).toBe(177_000);
  });

  it('HAPPY: prefers exact runner milliseconds when the record carries turns', () => {
    const flows = JSON.parse(fs.readFileSync(path.join(root, 'evidence/flows.json'), 'utf8'));
    flows[0].turns = [{ label: 'development-02-plan', durationMs: 94_321 }];
    write('evidence/flows.json', JSON.stringify(flows));
    expect(turn('development', 'development-02-plan')).toMatchObject({
      durationMs: 94_321,
      durationSource: 'runner_ms',
    });
  });

  it('BAD: a flow with any unmeasured turn has no summed duration', () => {
    write('evidence/development-05-extra.jsonl', jsonl([STEP]));
    expect(flow('development').flowDurationMs).toBe(NOT_OBSERVED);
  });

  it('HAPPY: splits a reviewer child into the native Task and the structured follow-up', () => {
    const reviews = flow('development').reviews as Array<Record<string, unknown>>;
    const review = reviews.find((candidate) => candidate.sessionId === CHILD) as Json;
    expect(review.task).toMatchObject({ modelActions: 1, modelMs: 60_000 });
    expect(review.followups).toEqual([
      expect.objectContaining({ modelActions: 1, modelMs: 9_000, verdict: 'changes_requested' }),
    ]);
    const taskOnly = reviews.find((candidate) => candidate.sessionId === CHILD_NO_FOLLOWUP) as Json;
    expect(taskOnly.followups).toBe(NOT_OBSERVED);
  });

  it('BAD: missing host exports are NOT_OBSERVED, never zero', () => {
    const negative = flow('architecture-negative');
    expect(negative.parent).toBe(NOT_OBSERVED);
    expect(negative.reviews).toBe(NOT_OBSERVED);
    expect(negative.runtimeLatency).toBe(NOT_OBSERVED);
  });

  it('ignores unregistered attempt files and refuses modified manifest-bound exports', () => {
    write(
      `evidence/development-attempt-99-host-${CHILD}.json`,
      JSON.stringify({
        info: { id: CHILD, parentID: PARENT },
        messages: [],
      }),
    );
    expect(
      (flow('development').reviews as Json[]).find((review) => review.sessionId === CHILD)?.task,
    ).toMatchObject({ modelActions: 1 });
    fs.appendFileSync(path.join(root, `evidence/development-host-${CHILD}.json`), ' ');
    expect((flow('development').reviews as Json[]).map((review) => review.sessionId)).not.toContain(
      CHILD,
    );
  });

  it('HAPPY: attributes FlowGuard latency logs to the flow via host and child sessions', () => {
    expect(flow('development').runtimeLatency).toMatchObject({
      toolCallsMeasured: 1,
      toolCallsUnavailable: 1,
      followupPromptMs: { n: 1, median: 9000 },
    });
  });
});

describe('demo perf baseline - statistics, output, and write safety', () => {
  it('CORNER: p95 tiers follow the agreed sample thresholds', () => {
    const series = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(describeSample(series(19)).p95).toEqual({ tier: 'insufficient_sample' });
    expect(describeSample(series(20)).p95).toEqual({ tier: 'exploratory', value: 19 });
    expect(describeSample(series(100)).p95).toEqual({ tier: 'descriptive', value: 95 });
    expect(describeSample([4, 1, 3]).median).toBe(3);
    expect(describeSample([]).median).toBe(NOT_OBSERVED);
  });

  it('BAD: the report and markdown carry no prompt, transcript, or repository content', () => {
    const report = buildReport([root]);
    const serialized = JSON.stringify(report) + renderMarkdown(report);
    expect(serialized).not.toContain('SECRET-PROMPT-CONTENT');
    expect(serialized).not.toContain('SECRET-REPOSITORY-CONTENT');
    expect(serialized).not.toContain(root);
    expect(report.summary.find((group) => group.flow === 'development')).toMatchObject({
      runs: 1,
      identity: { model: 'provider/model-x', hostVersion: '1.19.0', buildSha: 'feedbeefcafe0000' },
    });
  });

  it('EDGE: refuses to write outputs inside an analyzed run root', () => {
    expect(() => assertOutsideRoots(path.join(root, 'evidence', 'out.json'), [root])).toThrow(
      /refusing to write inside/,
    );
    expect(() => assertOutsideRoots(root, [root])).toThrow();
    expect(() =>
      assertOutsideRoots(path.join(os.tmpdir(), 'elsewhere.json'), [root]),
    ).not.toThrow();
  });

  it('EDGE: parses only well-formed driver log turn lines', () => {
    const turns = parseDriverLog('x a-01: exit=0 time=3s\nnoise\nx b-02: exit=1 time=x s');
    expect([...turns.keys()]).toEqual(['a-01']);
  });

  it('EDGE: the follow-up sentinel matches the product serialization prompt', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../integration/review/dispatch/structured-followup.ts'),
      'utf8',
    );
    expect(source).toContain(`'${FOLLOWUP_PROMPT_SENTINEL}'`);
  });
});

describe('summary attribution', () => {
  const identity = {
    model: 'test/model',
    hostVersion: '1.19.0',
    harnessVersion: 'demo-harness.v2',
    contractVersion: 'contract.v2',
    buildSha: 'b'.repeat(40),
  };
  function flowWith(denials: readonly Record<string, unknown>[]) {
    return {
      flow: 'architecture-negative',
      identity,
      result: 'FAILED',
      flowDurationMs: 1,
      reviewerMs: 1,
      processOverheadMs: NOT_OBSERVED,
      hostTurns: 1,
      turns: [{ denials }],
    };
  }

  it('reports controlled negatives by class, never as unattributed cost', () => {
    const controlled = {
      code: 'ARCHITECTURE_CLAIM_INVALID',
      class: 'controlled_negative',
      attribution: NOT_OBSERVED,
    };
    const unattributed = {
      code: 'WRONG_PHASE',
      class: 'governance_feedback',
      attribution: NOT_OBSERVED,
    };
    const groups = summarize([flowWith([controlled, unattributed])]);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    if (!group) throw new Error('expected one summary group');
    expect(group.denials.controlled_negative).toBe(1);
    expect(group.denials.notAttributed).toBe(1);
  });

  it('groups only measurements with identical identity versions', () => {
    const otherHarness = structuredClone(flowWith([]));
    otherHarness.identity.harnessVersion = 'demo-harness.v1';
    const otherContract = structuredClone(flowWith([]));
    otherContract.identity.contractVersion = 'contract.v1';
    expect(summarize([flowWith([]), otherHarness, otherContract])).toHaveLength(3);
    expect(summarize([flowWith([]), structuredClone(flowWith([]))])).toHaveLength(1);
  });
});
