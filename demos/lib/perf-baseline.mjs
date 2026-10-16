#!/usr/bin/env node
/**
 * @module demos/lib/perf-baseline
 * @description Read-only workflow latency baseline over archived live-run roots.
 *
 * Reads only what the live runners already wrote under `<run-root>/evidence/`
 * (`*.jsonl` host turns, `driver.log`, `flows.json` or
 * `risk-trigger-controls.json`, `metadata.json`, `*-host-<sessionId>.json`
 * host exports) and, when present, FlowGuard diagnostic logs under
 * `<run-root>/workspaces/**\/.opencode/logs/`. It never opens the host
 * database and never writes into a run root.
 *
 * Output contains identifiers, codes, labels, and numbers only - never prompt,
 * transcript, or repository content. Anything that cannot be reconstructed is
 * reported as `NOT_OBSERVED`; nothing is estimated:
 * - a denial's extra cost is attributed only for an occurrence-bound recovery
 *   (`sameTurnRecoveryProofs`) with no competing denial of the same tool in
 *   between, or for a runner-proven next-step recovery;
 * - a phase is reported only from an observed governed payload of that turn;
 * - model steps are counted only when the transcript carries step events;
 * - p95 is `insufficient_sample` below 20 comparable runs, `exploratory`
 *   from 20 to 99, and `descriptive` from 100.
 *
 * Usage:
 *   node demos/lib/perf-baseline.mjs <run-root> [<run-root>...] [--json <file>] [--md <file>]
 *
 * @version v1
 */

import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from './is-main-module.mjs';
import {
  eventsOf,
  governedToolEvents,
  sameTurnRecoveryProofs,
  toolDenialEvents,
  toolUseEvents,
} from './transcript.mjs';
import {
  CONTROLLED_NEGATIVE_STEPS,
  DENIAL_BASELINE,
  NEXT_STEP_RECOVERY_CODES,
  PLAN_REVIEW_CORRECTION_CODE,
} from '../java-task-manager/run-live-matrix.mjs';

export const NOT_OBSERVED = 'NOT_OBSERVED';

/**
 * Default code classes. Context outranks these defaults:
 * - the fixture's `requiredControls` declares a code expected in that flow, and
 * - a runner-declared control step (`CONTROLLED_NEGATIVE_STEPS`) declares the
 *   ONE typed denial it asserts for that exact step.
 * A denial inside a negative flow but outside a declared control step, or with
 * a different code than the control declares, is classified by its own code.
 */
export const WAIT_STATE_CODES = new Set(['ADR_REVIEW_IN_PROGRESS', PLAN_REVIEW_CORRECTION_CODE]);
export const CALL_SHAPE_CODES = new Set([
  'INVALID_PLAN_TOOL_SEQUENCE',
  'INVALID_IMPLEMENT_TOOL_SEQUENCE',
  'PLAN_APPROVE_WITH_TEXT',
  'PLAN_SUBMISSION_REQUIRED',
  'COMMAND_NOT_ALLOWED',
  'WRONG_PHASE',
  'ADR_SUBMISSION_MIXED_INPUTS',
  'TICKET_SOURCE_CONFLICT',
  'EMPTY_ADR_TITLE',
  'EMPTY_ADR_TEXT',
  ...NEXT_STEP_RECOVERY_CODES,
]);
export const GOVERNANCE_FEEDBACK_CODES = new Set([
  'PROOFGRAPH_CLAIM_NOT_DECLARED',
  'PROOFGRAPH_CLAIM_UNSATISFIABLE',
  'PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE',
  'PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED',
  'ARCHITECTURE_CLAIM_INVALID',
  'REVISED_PLAN_REQUIRED',
  'REVISED_PLAN_CLAIMS_REQUIRED',
  'CONTENT_ANALYSIS_REQUIRED',
]);

/**
 * Stable first line of FlowGuard's structured follow-up prompt
 * (`src/integration/review/dispatch/structured-followup.ts`). Used only to split
 * a reviewer child into Task and follow-up segments; never emitted.
 */
export const FOLLOWUP_PROMPT_SENTINEL =
  'The independent FlowGuard review in this child session is complete.';

const P95_EXPLORATORY_MIN = 20;
const P95_DESCRIPTIVE_MIN = 100;
const VERDICTS = new Set(['accept', 'changes_requested', 'unable_to_review']);

// ─── Small readers ───────────────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `<iso> <label>: exit=<code> time=<seconds>s` lines written by the runner. */
export function parseDriverLog(content) {
  const turns = new Map();
  for (const line of String(content).split('\n')) {
    const match = /^\S+ (\S+): exit=(\S+) time=(\d+)s$/.exec(line.trim());
    if (match) turns.set(match[1], { exitCode: match[2], seconds: Number(match[3]) });
  }
  return turns;
}

// ─── Statistics ──────────────────────────────────────────────────────────────

export function describeSample(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0)
    return { n: 0, values: [], median: NOT_OBSERVED, p95: { tier: 'insufficient_sample' } };
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const tier =
    n >= P95_DESCRIPTIVE_MIN ? 'descriptive' : n >= P95_EXPLORATORY_MIN ? 'exploratory' : null;
  const p95 =
    tier === null
      ? { tier: 'insufficient_sample' }
      : { tier, value: sorted[Math.max(0, Math.ceil(0.95 * n) - 1)] };
  return { n, values: sorted, median, p95 };
}

// ─── Denials ─────────────────────────────────────────────────────────────────

export function classifyDenial({ code, flow, step }) {
  if ((DENIAL_BASELINE.requiredControls?.[flow] ?? []).includes(code)) {
    return 'controlled_negative';
  }
  if (step !== undefined && CONTROLLED_NEGATIVE_STEPS.get(step) === code) {
    return 'controlled_negative';
  }
  if (WAIT_STATE_CODES.has(code)) return 'wait_state';
  if (CALL_SHAPE_CODES.has(code)) return 'avoidable_call_shape';
  if (GOVERNANCE_FEEDBACK_CODES.has(code)) return 'governance_feedback';
  return 'unexpected';
}

/** Phase from the nearest preceding governed payload of THIS turn, else NOT_OBSERVED. */
function observedPhaseAt(output, index) {
  let phase = NOT_OBSERVED;
  for (const event of governedToolEvents(output)) {
    if (event.index > index) break;
    const value = event.payload.kind === 'json' ? event.payload.value : undefined;
    const candidate = safeString(value?.phase);
    if (candidate !== undefined) phase = candidate;
  }
  return phase;
}

function countStepStarts(events, fromIndex, toIndex) {
  let steps = 0;
  for (let position = fromIndex; position < toIndex - 1; position += 1) {
    if (events[position]?.type === 'step_start') steps += 1;
  }
  return steps;
}

function nextStepRecovered(record, step, code) {
  return (record?.recoveredDenials ?? []).some(
    (entry) =>
      entry?.step === step &&
      Array.isArray(entry.codes) &&
      entry.codes.includes(code) &&
      typeof entry.evidence === 'string' &&
      entry.evidence.startsWith('next_step_operation_transition:'),
  );
}

/** Per-occurrence denial facts with causal attribution only where it is proven. */
export function analyzeTurnDenials({ output, flow, step, record }) {
  const events = eventsOf(output);
  const hasStepEvents = events.some((event) => event.type === 'step_start');
  const denials = toolDenialEvents(output);
  const { recovered } = sameTurnRecoveryProofs(output);
  return denials.map((denial) => {
    const base = {
      code: denial.code,
      tool: denial.tool ?? NOT_OBSERVED,
      flow,
      step,
      phase: observedPhaseAt(output, denial.index),
      class: classifyDenial({ code: denial.code, flow, step }),
    };
    const proof = recovered.find(
      (candidate) => candidate.denialIndex === denial.index && candidate.code === denial.code,
    );
    if (proof !== undefined) {
      const competing = denials.some(
        (other) =>
          other !== denial &&
          other.tool === denial.tool &&
          other.index > denial.index &&
          other.index < proof.successIndex,
      );
      if (competing) return { ...base, recovery: 'same_turn', attribution: NOT_OBSERVED };
      const between = toolUseEvents(output).filter(
        (event) => event.index > denial.index && event.index <= proof.successIndex,
      ).length;
      return {
        ...base,
        recovery: 'same_turn',
        attribution: 'attributed',
        binding: proof.binding,
        extraToolCalls: between,
        extraModelSteps: hasStepEvents
          ? countStepStarts(events, denial.index, proof.successIndex)
          : NOT_OBSERVED,
        extraHostTurns: 0,
      };
    }
    if (nextStepRecovered(record, step, denial.code)) {
      return {
        ...base,
        recovery: 'next_turn',
        attribution: 'attributed',
        extraToolCalls: NOT_OBSERVED,
        extraModelSteps: NOT_OBSERVED,
        extraHostTurns: 1,
      };
    }
    return { ...base, recovery: NOT_OBSERVED, attribution: NOT_OBSERVED };
  });
}

// ─── Host exports ────────────────────────────────────────────────────────────

function tokenTotals(messages) {
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let observed = 0;
  for (const message of messages) {
    const tokens = message.info?.tokens;
    if (tokens === undefined || typeof tokens !== 'object' || tokens === null) continue;
    observed += 1;
    totals.input += finiteNumber(tokens.input) ?? 0;
    totals.output += finiteNumber(tokens.output) ?? 0;
    totals.reasoning += finiteNumber(tokens.reasoning) ?? 0;
    totals.cacheRead += finiteNumber(tokens.cache?.read) ?? 0;
    totals.cacheWrite += finiteNumber(tokens.cache?.write) ?? 0;
  }
  return observed === 0 ? NOT_OBSERVED : totals;
}

function modelMs(messages) {
  let total = 0;
  for (const message of messages) {
    const created = finiteNumber(message.info?.time?.created);
    const completed = finiteNumber(message.info?.time?.completed);
    if (created === undefined || completed === undefined || completed < created) {
      return NOT_OBSERVED;
    }
    total += completed - created;
  }
  return total;
}

function segmentSummary(messages) {
  const assistants = messages.filter((message) => message.info?.role === 'assistant');
  return {
    modelActions: assistants.length,
    modelMs: assistants.length === 0 ? NOT_OBSERVED : modelMs(assistants),
    tokens: tokenTotals(assistants),
  };
}

function isFollowupPrompt(message) {
  return (
    message.info?.role === 'user' &&
    (message.parts ?? []).some(
      (part) =>
        part?.type === 'text' && String(part.text ?? '').startsWith(FOLLOWUP_PROMPT_SENTINEL),
    )
  );
}

function followupVerdict(messages) {
  for (const message of messages) {
    const verdict = message.info?.structured?.overallVerdict;
    if (VERDICTS.has(verdict)) return verdict;
  }
  return NOT_OBSERVED;
}

/**
 * Split a reviewer child at FlowGuard's follow-up prompts: segment 0 is the
 * native Task, every later segment is one structured follow-up.
 */
export function analyzeReviewerExport(exported) {
  const messages = Array.isArray(exported?.messages) ? exported.messages : [];
  const segments = [[]];
  for (const message of messages) {
    if (isFollowupPrompt(message)) segments.push([]);
    segments.at(-1).push(message);
  }
  const [task, ...followups] = segments;
  return {
    sessionId: safeString(exported?.info?.id) ?? NOT_OBSERVED,
    task: segmentSummary(task),
    followups:
      followups.length === 0
        ? NOT_OBSERVED
        : followups.map((segment) => ({
            ...segmentSummary(segment),
            verdict: followupVerdict(segment),
          })),
  };
}

export function analyzeParentExport(exported) {
  const messages = Array.isArray(exported?.messages) ? exported.messages : [];
  return {
    sessionId: safeString(exported?.info?.id) ?? NOT_OBSERVED,
    ...segmentSummary(messages),
  };
}

// ─── Runtime diagnostic logs (optional) ──────────────────────────────────────

function logFiles(root) {
  const workspaces = path.join(root, 'workspaces');
  if (!fs.existsSync(workspaces)) return [];
  const files = [];
  for (const workspace of fs.readdirSync(workspaces, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const logs = path.join(workspaces, workspace.name, '.opencode', 'logs');
    if (!fs.existsSync(logs)) continue;
    for (const entry of fs.readdirSync(logs)) {
      if (/^flowguard-.*\.log$/.test(entry)) files.push(path.join(logs, entry));
    }
  }
  return files;
}

function emptyBucket() {
  return { toolMs: [], toolUnavailable: 0, followupPromptMs: [], followupNotInvoked: 0 };
}

/**
 * FlowGuard latency diagnostics. Tool lines are keyed by the host session id of
 * their log context; follow-up lines by their reviewer `childSessionId` (the
 * native review path has no session log context). Absent logs are simply absent.
 */
export function collectRuntimeLatency(root) {
  const bySession = new Map();
  const byChild = new Map();
  const add = (map, key, update) => {
    const bucket = map.get(key) ?? emptyBucket();
    update(bucket);
    map.set(key, bucket);
  };
  for (const file of logFiles(root)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const extra = entry?.extra ?? {};
      if (entry?.message === 'tool.execute.after') {
        const value = finiteNumber(extra.beforeToAfterMs);
        const unavailable = typeof extra.durationUnavailable === 'string';
        if (value === undefined && !unavailable) continue;
        add(bySession, safeString(entry.sessionId) ?? NOT_OBSERVED, (bucket) => {
          if (value !== undefined) bucket.toolMs.push(value);
          else bucket.toolUnavailable += 1;
        });
      } else if (entry?.message === 'review structured followup timing') {
        const value = finiteNumber(extra.followupPromptMs);
        const notInvoked = extra.followupPromptMsUnavailable === 'not_invoked';
        if (value === undefined && !notInvoked) continue;
        add(byChild, safeString(extra.childSessionId) ?? NOT_OBSERVED, (bucket) => {
          if (value !== undefined) bucket.followupPromptMs.push(value);
          else bucket.followupNotInvoked += 1;
        });
      }
    }
  }
  return { bySession, byChild };
}

function flowRuntimeLatency(runtime, hostSessionId, childSessionIds) {
  if (hostSessionId === undefined) return NOT_OBSERVED;
  const merged = emptyBucket();
  let observed = false;
  for (const bucket of [
    runtime.bySession.get(hostSessionId),
    ...childSessionIds.flatMap((id) => [runtime.bySession.get(id), runtime.byChild.get(id)]),
  ]) {
    if (bucket === undefined) continue;
    observed = true;
    merged.toolMs.push(...bucket.toolMs);
    merged.toolUnavailable += bucket.toolUnavailable;
    merged.followupPromptMs.push(...bucket.followupPromptMs);
    merged.followupNotInvoked += bucket.followupNotInvoked;
  }
  if (!observed) return NOT_OBSERVED;
  return {
    toolCallsMeasured: merged.toolMs.length,
    toolCallsUnavailable: merged.toolUnavailable,
    beforeToAfterMs: describeSample(merged.toolMs),
    followupPromptMs: describeSample(merged.followupPromptMs),
    followupNotInvoked: merged.followupNotInvoked,
  };
}

// ─── Run roots ───────────────────────────────────────────────────────────────

function flowRecords(evidenceDir) {
  for (const file of ['flows.json', 'risk-trigger-controls.json']) {
    const records = readJson(path.join(evidenceDir, file));
    if (Array.isArray(records)) return records.filter((record) => safeString(record?.name));
  }
  return [];
}

function flowForLabel(records, label) {
  const matches = records
    .map((record) => record.name)
    .filter((name) => label.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length);
  return matches[0] ?? NOT_OBSERVED;
}

function turnDuration(record, label, driverTurns) {
  const runnerTurn = (record?.turns ?? []).find((turn) => turn?.label === label);
  const runnerMs = finiteNumber(runnerTurn?.durationMs);
  if (runnerMs !== undefined) return { durationMs: runnerMs, durationSource: 'runner_ms' };
  const driver = driverTurns.get(label);
  if (driver !== undefined) {
    return { durationMs: driver.seconds * 1000, durationSource: 'driver_log_seconds' };
  }
  return { durationMs: NOT_OBSERVED, durationSource: NOT_OBSERVED };
}

function analyzeTurn({ evidenceDir, file, records, driverTurns }) {
  const step = path.basename(file, '.jsonl');
  const flow = flowForLabel(records, step);
  const record = records.find((candidate) => candidate.name === flow);
  const output = fs.readFileSync(path.join(evidenceDir, file), 'utf8');
  const events = eventsOf(output);
  const hasStepEvents = events.some((event) => event.type === 'step_start');
  const governed = governedToolEvents(output);
  const lastPhase = [...governed]
    .reverse()
    .map((event) =>
      event.payload.kind === 'json' ? safeString(event.payload.value?.phase) : undefined,
    )
    .find((phase) => phase !== undefined);
  return {
    flow,
    step,
    ...turnDuration(record, step, driverTurns),
    exitCode: driverTurns.get(step)?.exitCode ?? NOT_OBSERVED,
    phaseObserved: lastPhase ?? NOT_OBSERVED,
    toolCalls: toolUseEvents(output).length,
    modelSteps: hasStepEvents
      ? events.filter((event) => event.type === 'step_start').length
      : NOT_OBSERVED,
    denials: analyzeTurnDenials({ output, flow, step, record }),
  };
}

function exportsBySession(evidenceDir) {
  const parents = new Map();
  const children = new Map();
  for (const file of fs.readdirSync(evidenceDir)) {
    if (!/-host-[A-Za-z0-9_-]+\.json$/.test(file)) continue;
    const exported = readJson(path.join(evidenceDir, file));
    const id = safeString(exported?.info?.id);
    if (id === undefined) continue;
    const parentId = safeString(exported.info.parentID);
    if (parentId === undefined) parents.set(id, exported);
    else children.set(id, { parentId, exported });
  }
  return { parents, children };
}

function flowIdentity(metadata, record) {
  return {
    model: safeString(metadata?.model) ?? NOT_OBSERVED,
    hostVersion: safeString(metadata?.pins?.opencode) ?? NOT_OBSERVED,
    harnessVersion: safeString(metadata?.harnessVersion) ?? NOT_OBSERVED,
    contractVersion: safeString(metadata?.contractVersion) ?? NOT_OBSERVED,
    buildSha:
      safeString(record?.installedBuild?.gitSha) ??
      safeString(metadata?.checkoutHead) ??
      NOT_OBSERVED,
  };
}

/** Reviewer-child wall time (session info.time span) for one exported child. */
function exportedSessionElapsedMs(exported) {
  const created = exported?.info?.time?.created;
  const updated = exported?.info?.time?.updated;
  return typeof created === 'number' && typeof updated === 'number' && updated >= created
    ? updated - created
    : NOT_OBSERVED;
}

function sumOrNotObserved(values) {
  return values.length > 0 && values.every((value) => typeof value === 'number')
    ? values.reduce((total, value) => total + value, 0)
    : NOT_OBSERVED;
}

/** Analyze one run root into per-flow records. */
export function analyzeRunRoot(root) {
  const evidenceDir = path.join(root, 'evidence');
  if (!fs.existsSync(evidenceDir)) throw new Error(`no evidence directory in run root: ${root}`);
  const records = flowRecords(evidenceDir);
  const metadata = readJson(path.join(evidenceDir, 'metadata.json'));
  const driverLog = path.join(evidenceDir, 'driver.log');
  const driverTurns = fs.existsSync(driverLog)
    ? parseDriverLog(fs.readFileSync(driverLog, 'utf8'))
    : new Map();
  const turns = fs
    .readdirSync(evidenceDir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .map((file) => analyzeTurn({ evidenceDir, file, records, driverTurns }));
  const { parents, children } = exportsBySession(evidenceDir);
  const runtime = collectRuntimeLatency(root);
  const flowNames = [
    ...new Set([...records.map((record) => record.name), ...turns.map((turn) => turn.flow)]),
  ];
  return flowNames.map((flow) => {
    const record = records.find((candidate) => candidate.name === flow);
    const flowTurns = turns.filter((turn) => turn.flow === flow);
    const hostSessionId = safeString(record?.hostSessionId);
    const parent = hostSessionId === undefined ? undefined : parents.get(hostSessionId);
    const flowChildren = [...children.entries()].filter(
      ([, child]) => hostSessionId !== undefined && child.parentId === hostSessionId,
    );
    const reviews = flowChildren.map(([, child]) => analyzeReviewerExport(child.exported));
    const flowDurationMs = sumOrNotObserved(flowTurns.map((turn) => turn.durationMs));
    const reviewerMs = sumOrNotObserved(
      flowChildren.map(([, child]) => exportedSessionElapsedMs(child.exported)),
    );
    // Process overhead requires a real process-level measurement; the host-turn
    // sum minus reviewer-child elapsed is NOT that measurement (it also contains
    // regular agent work outside reviewer children and differently bounded
    // windows), so it stays NOT_OBSERVED rather than reporting an unproven
    // time category.
    const processOverheadMs = NOT_OBSERVED;
    return {
      root: path.basename(path.resolve(root)),
      flow,
      result: safeString(record?.result) ?? NOT_OBSERVED,
      identity: flowIdentity(metadata, record),
      hostTurns: flowTurns.length,
      flowDurationMs,
      reviewerMs,
      processOverheadMs,
      turns: flowTurns,
      parent: parent === undefined ? NOT_OBSERVED : analyzeParentExport(parent),
      reviews: reviews.length === 0 ? NOT_OBSERVED : reviews,
      runtimeLatency: flowRuntimeLatency(
        runtime,
        hostSessionId,
        flowChildren.map(([id]) => id),
      ),
    };
  });
}

// ─── Aggregation and rendering ───────────────────────────────────────────────

function countDenials(flows, predicate) {
  return flows.flatMap((flow) => flow.turns.flatMap((turn) => turn.denials)).filter(predicate)
    .length;
}

/** Group comparable flows (same flow, model, host version, harness version, contract version, build). */
export function summarize(flows) {
  const groups = new Map();
  for (const flow of flows) {
    const key = [
      flow.flow,
      flow.identity.model,
      flow.identity.hostVersion,
      flow.identity.harnessVersion,
      flow.identity.contractVersion,
      flow.identity.buildSha,
    ].join('|');
    groups.set(key, [...(groups.get(key) ?? []), flow]);
  }
  return [...groups.values()].map((group) => ({
    flow: group[0].flow,
    identity: group[0].identity,
    runs: group.length,
    results: Object.fromEntries(
      [...new Set(group.map((flow) => flow.result))].map((result) => [
        result,
        group.filter((flow) => flow.result === result).length,
      ]),
    ),
    flowDurationMs: describeSample(group.map((flow) => flow.flowDurationMs)),
    flowDurationNotObserved: group.filter((flow) => flow.flowDurationMs === NOT_OBSERVED).length,
    reviewerMs: describeSample(group.map((flow) => flow.reviewerMs)),
    processOverheadMs: describeSample(group.map((flow) => flow.processOverheadMs)),
    hostTurns: describeSample(group.map((flow) => flow.hostTurns)),
    denials: {
      controlled_negative: countDenials(group, (d) => d.class === 'controlled_negative'),
      avoidable_call_shape: countDenials(group, (d) => d.class === 'avoidable_call_shape'),
      governance_feedback: countDenials(group, (d) => d.class === 'governance_feedback'),
      wait_state: countDenials(group, (d) => d.class === 'wait_state'),
      unexpected: countDenials(group, (d) => d.class === 'unexpected'),
      attributed: countDenials(group, (d) => d.attribution === 'attributed'),
      notAttributed: countDenials(group, (d) => d.attribution === NOT_OBSERVED),
    },
  }));
}

export function buildReport(roots) {
  const flows = roots.flatMap((root) => analyzeRunRoot(root));
  return { version: 'perf-baseline.v1', flows, summary: summarize(flows) };
}

function cell(value) {
  if (value === NOT_OBSERVED) return NOT_OBSERVED;
  return typeof value === 'number' ? String(Math.round(value)) : String(value);
}

export function renderMarkdown(report) {
  const lines = [
    '# Workflow latency baseline',
    '',
    'Identifiers, codes, and numbers only. `NOT_OBSERVED` means the run root does not',
    'contain the evidence; nothing is estimated.',
    '',
    '| Flow | Model | Build | Runs | Median flow ms | p95 | Median host turns | Median reviewer ms | Median overhead ms | Avoidable call-shape denials | Attributed denials |',
    '| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const group of report.summary) {
    const p95 = group.flowDurationMs.p95;
    lines.push(
      `| ${group.flow} | ${group.identity.model} | ${String(group.identity.buildSha).slice(0, 12)} | ${group.runs} | ${cell(group.flowDurationMs.median)} | ${p95.value === undefined ? p95.tier : `${cell(p95.value)} (${p95.tier})`} | ${cell(group.hostTurns.median)} | ${cell(group.reviewerMs.median)} | ${cell(group.processOverheadMs.median)} | ${group.denials.avoidable_call_shape} | ${group.denials.attributed} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { roots: [], json: undefined, md: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json' || arg === '--md') {
      const value = argv[(index += 1)];
      if (value === undefined) throw new Error(`${arg} requires a file path`);
      options[arg.slice(2)] = path.resolve(value);
    } else {
      options.roots.push(path.resolve(arg));
    }
  }
  if (options.roots.length === 0) throw new Error('at least one <run-root> is required');
  return options;
}

/** Outputs may never be written into an analyzed run root. */
export function assertOutsideRoots(outputPath, roots) {
  for (const root of roots) {
    const relative = path.relative(root, outputPath);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error(`refusing to write inside an analyzed run root: ${outputPath}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const target of [options.json, options.md]) {
    if (target !== undefined) assertOutsideRoots(target, options.roots);
  }
  const report = buildReport(options.roots);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.json !== undefined) fs.writeFileSync(options.json, json, { flag: 'wx' });
  if (options.md !== undefined)
    fs.writeFileSync(options.md, renderMarkdown(report), { flag: 'wx' });
  if (options.json === undefined && options.md === undefined) process.stdout.write(json);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[perf-baseline] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
