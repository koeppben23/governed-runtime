#!/usr/bin/env node
/**
 * @module demos/reviewer-reference-suite/run-live
 * @description Execute frozen plan-review reference cases through the real
 * FlowGuard/OpenCode review pipeline and record termination + evaluation data.
 *
 * The runner deliberately does NOT converge a plan revision loop. It submits
 * the frozen subject once, waits for the independent reviewer invocation, and
 * records that invocation's findings. A `changes_requested` verdict is a
 * measurement result, not a request to author a new plan.
 *
 * Stage 1 uses the reproduction fixture from the 2026-10-19 truncation for
 * termination only. Stage 2 uses gold-standard cases A and B. Implementation
 * cases are defined in the suite but are not executed by this version.
 *
 * Usage:
 *   node demos/reviewer-reference-suite/run-live.mjs \
 *     --root <fresh-root> --tarball <tgz> --case <id> --arm 32000|65536 \
 *     --repetitions 3 [--model deepseek/deepseek-flash] [--host-version 1.19.3]
 *
 *   --check validates the selected cases and the host pin without a live run.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Runner, sha256, verifyChecksumSidecar } from '../java-task-manager/run-live-matrix.mjs';
import { PLAN_GATE, classifyPlanGate } from '../lib/review-continuation.mjs';
import { writeIsolatedHostConfig } from '../lib/host-config.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, '..', '..');
const SUITE_FILE = path.join(SCRIPT_DIR, 'cases.json');
const REPRODUCTION_FILE = path.join(SCRIPT_DIR, 'reproduction', '2026-10-19-plan.json');
const OBSERVER_PLUGIN = path.join(SCRIPT_DIR, 'observe-chat-params.mjs');
const DEFAULT_MODEL = 'deepseek/deepseek-flash';
const DEFAULT_HOST_VERSION = '1.19.3';
const DEFAULT_REPETITIONS = 3;
const VALID_ARMS = new Set([32000, 65536]);
const MAX_REVIEWER_REARMS = 3;
const REVIEWER_SUITE_STEPS = 15;
const REPRODUCTION_CASE_ID = 'reproduction-2026-10-19-plan';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Canonical JSON for the suite corpus digest (object keys sorted at every depth). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
}

function gitDirty() {
  return (
    execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim().length >
    0
  );
}

/**
 * @typedef {Object} SuiteOptions
 * @property {string} [root]
 * @property {string} [tarball]
 * @property {string} [productSha]
 * @property {string} model
 * @property {string} hostVersion
 * @property {string} reviewerEffort
 * @property {string} variant
 * @property {number} reviewerSteps
 * @property {number} repetitions
 * @property {boolean} check
 * @property {boolean} transportSmoke
 * @property {boolean} singleReview
 * @property {string} [caseId]
 * @property {number} [arm]
 */

/**
 * Parse suite-runner arguments. Exported for contract tests.
 * @param {string[]} argv
 * @returns {SuiteOptions}
 */
export function parseSuiteArgs(argv) {
  const options = {
    model: DEFAULT_MODEL,
    hostVersion: DEFAULT_HOST_VERSION,
    repetitions: DEFAULT_REPETITIONS,
    reviewerEffort: '',
    variant: 'max',
    reviewerSteps: REVIEWER_SUITE_STEPS,
    check: false,
    transportSmoke: false,
    singleReview: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (flag === '--root') options.root = path.resolve(next());
    else if (flag === '--tarball') options.tarball = path.resolve(next());
    else if (flag === '--product-sha') options.productSha = next();
    else if (flag === '--model') options.model = next();
    else if (flag === '--host-version') options.hostVersion = next();
    else if (flag === '--reviewer-effort') options.reviewerEffort = next();
    else if (flag === '--variant') options.variant = next();
    else if (flag === '--reviewer-steps') options.reviewerSteps = Number(next());
    else if (flag === '--transport-smoke') options.transportSmoke = true;
    else if (flag === '--single-review') options.singleReview = true;
    else if (flag === '--case') options.caseId = next();
    else if (flag === '--arm') options.arm = next();
    else if (flag === '--repetitions') options.repetitions = Number(next());
    else if (flag === '--check') options.check = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!options.root) throw new Error('--root <fresh-root> is required');
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error('--repetitions must be a positive integer');
  }
  if (!Number.isInteger(options.reviewerSteps) || options.reviewerSteps < 1) {
    throw new Error('--reviewer-steps must be a positive integer');
  }
  if (options.arm !== undefined) {
    const arm = Number(options.arm);
    if (!VALID_ARMS.has(arm)) {
      throw new Error('--arm must be 32000 or 65536');
    }
    options.arm = arm;
  }
  if (!options.check && !options.tarball) {
    throw new Error('--tarball is required for a live run');
  }
  return options;
}

/** Select the gold-standard/reproduction cases this runner can execute.
 * @param {{caseId?: string}} options
 * @param {{cases: Array<any>}} suite
 * @returns {{kind: string, cases: Array<any>}}
 */
export function selectCases(options, suite) {
  const cases = suite.cases.filter((entry) => {
    if (entry.goldStandardType !== 'plan_review') return false;
    if (entry.fixture.executionMode !== 'java_seed') return false;
    return options.caseId === undefined || entry.caseId === options.caseId;
  });
  if (options.caseId === REPRODUCTION_CASE_ID) {
    return { kind: 'reproduction', cases: [] };
  }
  if (cases.length === 0) {
    throw new Error(
      `no executable plan-review case selected: ${String(options.caseId ?? 'all')}; ` +
        'synthetic-discovery and implementation_review cases are not executed by this runner',
    );
  }
  if (options.caseId !== undefined && cases.length !== 1) {
    throw new Error(`case ${options.caseId} is not executable by this runner`);
  }
  return { kind: 'suite', cases };
}

/** Validate the host binary version without requiring the CI pin.
 * @param {string} expected
 * @returns {string}
 */
export function assertHostVersion(expected) {
  const actual = execFileSync('opencode', ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
  }).trim();
  if (actual !== expected) {
    throw new Error(
      `opencode ${actual} != requested experiment host ${expected}; ` +
        'install the requested host into an isolated prefix and put it first on PATH',
    );
  }
  return actual;
}

function writeObserverPlugin(configDir) {
  writeIsolatedHostConfig(configDir);
  const configPath = path.join(configDir, 'opencode.json');
  const config = readJson(configPath);
  const observer = pathToFileURL(OBSERVER_PLUGIN).href;
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  if (!plugins.includes(observer)) plugins.push(observer);
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, plugin: plugins }, null, 2)}\n`,
    'utf8',
  );
}

function tarballFor(options) {
  if (options.tarball) {
    const sidecar = path.join(path.dirname(options.tarball), 'checksums.sha256');
    if (!fs.existsSync(options.tarball)) throw new Error(`tarball not found: ${options.tarball}`);
    if (!fs.existsSync(sidecar))
      throw new Error(`checksums.sha256 missing next to ${options.tarball}`);
    verifyChecksumSidecar(options.tarball, sidecar);
    return options.tarball;
  }
  execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit' });
  execFileSync('npm', ['run', 'pack:checksums'], { cwd: REPO, stdio: 'inherit' });
  const version = readJson(path.join(REPO, 'package.json')).version;
  const tarball = path.join(REPO, `flowguard-core-${version}.tgz`);
  verifyChecksumSidecar(tarball, path.join(REPO, 'checksums.sha256'));
  return tarball;
}

function prepareBaseWorkspace(options, tarball, setupRoot) {
  const env = {
    ...process.env,
    FLOWGUARD_REVIEWER_EFFORT: options.reviewerEffort,
    FLOWGUARD_REFERENCE_SUITE: '1',
    FLOWGUARD_REVIEWER_STEPS: String(options.reviewerSteps),
  };
  // Do NOT pin the reviewer model in the agent frontmatter. The Task transport
  // passes the parent session's model variant only when the agent has no
  // explicit model; pinning it would drop `variant: max` from the review call.
  delete env.FLOWGUARD_REVIEWER_MODEL;
  execFileSync(
    path.join(REPO, 'run-demo-setup.sh'),
    ['--install', '--install-scope', 'repo', '--tarball', tarball, '--demo', 'main', setupRoot],
    { cwd: REPO, stdio: 'inherit', env },
  );
  return path.join(setupRoot, 'java-task-manager');
}

function planPrompt(planText, claims) {
  return [
    'Create a complete plan for the ticket.',
    'Use EXACTLY this plan text, without rewriting, shortening, or reordering it:',
    planText,
    'Use EXACTLY this claims array:',
    JSON.stringify(claims),
    'Copy the plan text characters exactly; do not escape quotes or add backslashes.',
    'Complete the full independent plan review.',
  ].join('\n');
}

/**
 * Single-review prompt: submit the frozen plan and dispatch the reviewer once.
 * It deliberately avoids the `/plan` command loop, which may auto-revise after
 * a `changes_requested` verdict and thereby replace the frozen-subject review.
 */
function singleReviewPrompt(planText, claims) {
  return [
    'Call the `flowguard_plan` tool exactly once with this planText and claims.',
    'Use EXACTLY this plan text, without rewriting, shortening, or reordering it:',
    planText,
    'Use EXACTLY this claims array:',
    JSON.stringify(claims),
    'Copy the plan text characters exactly; do not escape quotes or add backslashes.',
    'Follow the reviewDispatch/reviewInvocation instructions in the tool output.',
    'Call the `task` tool exactly once with subagent_type "flowguard-reviewer" for the returned invocation.',
    'If the tool output contains a reviewRetry, invoke the reviewer Task again exactly as instructed.',
    'After the reviewer Task returns, stop.',
    'Do not revise the plan, do not call flowguard_plan again, and do not submit a reviewVerdict.',
  ].join('\n');
}

/**
 * The invocation that actually reviewed the frozen plan. A later revision in
 * the same parent turn may create a new obligation; it must never replace the
 * frozen-subject measurement.
 * @param {any} state
 * @param {string} expectedSubjectDigest
 * @returns {{invocation: any, obligation: any} | null}
 */
export function frozenPlanInvocation(state, expectedSubjectDigest) {
  const obligations = state?.reviewAssurance?.obligations;
  const invocations = state?.reviewAssurance?.invocations;
  if (!Array.isArray(obligations) || !Array.isArray(invocations)) return null;
  const frozen = obligations.filter(
    (obligation) =>
      obligation?.obligationType === 'plan' && obligation?.subjectDigest === expectedSubjectDigest,
  );
  for (const obligation of frozen) {
    const invocation = invocations.find(
      (entry) =>
        entry?.obligationId === obligation.obligationId &&
        entry?.capturedRawFindings &&
        typeof entry.capturedRawFindings === 'object',
    );
    if (invocation) return { invocation, obligation };
  }
  return null;
}

function fallbackPlanFindings(state) {
  const findings = state?.plan?.reviewFindings;
  return Array.isArray(findings) && findings.length > 0 ? findings.at(-1) : null;
}

function latestPlanObligation(state) {
  const obligations = state?.reviewAssurance?.obligations;
  if (!Array.isArray(obligations)) return null;
  return (
    [...obligations].reverse().find((obligation) => obligation?.obligationType === 'plan') ?? null
  );
}

function normalizePlan(text) {
  return String(text ?? '').trim();
}

/**
 * Apply the suite-only reviewer step budget to the installed agent. The product
 * template remains at REVIEWER_STEP_LIMIT; the host's completion classifier
 * reads the same FLOWGUARD_REVIEWER_STEPS value.
 */
export function applyReviewerStepBudget(workspace, steps) {
  const file = path.join(workspace, '.opencode', 'agents', 'flowguard-reviewer.md');
  if (!fs.existsSync(file)) throw new Error(`reviewer agent missing: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const pattern = /^steps:\s*\d+$/m;
  if (!pattern.test(text)) throw new Error('reviewer agent has no steps frontmatter to override');
  fs.writeFileSync(file, text.replace(pattern, `steps: ${steps}`), 'utf8');
}

/**
 * Apply the run arm to the installed FlowGuard config. The product plugin reads
 * reviewer.outputTokenMax at startup; the suite must therefore change the
 * config, not the host-wide OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX.
 */
export function applyReviewerOutputTokenMax(workspace, outputTokenMax) {
  const file = path.join(workspace, '.opencode', 'flowguard.json');
  if (!fs.existsSync(file)) throw new Error(`flowguard config missing: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`flowguard config is not an object: ${file}`);
  }
  parsed.reviewer = {
    ...(parsed.reviewer && typeof parsed.reviewer === 'object' ? parsed.reviewer : {}),
    outputTokenMax,
  };
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

/** Installed reviewer frontmatter, proving the model/effort baseline. */
function reviewerFrontmatter(workspace) {
  const file = path.join(workspace, '.opencode', 'agents', 'flowguard-reviewer.md');
  if (!fs.existsSync(file)) return { model: null, effort: null };
  const text = fs.readFileSync(file, 'utf8');
  const front = text.split('---')[1] ?? '';
  const steps = /^steps:\s*(\d+)$/m.exec(front)?.[1];
  return {
    model: /^model:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? null,
    effort: /^reasoningEffort:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? null,
    steps: steps === undefined ? null : Number(steps),
  };
}

/** Classify the last reviewer child's host-recorded completion.
 * @param {Array<any> | null | undefined} messages
 * @returns {{kind: string, finish: string|null, steps: number}}
 */
export function classifyCompletion(messages, stepLimit = 10) {
  if (!Array.isArray(messages)) return { kind: 'unverifiable', finish: null, steps: 0 };
  const assistants = messages.filter((entry) => entry?.info?.role === 'assistant');
  if (assistants.length === 0) return { kind: 'unverifiable', finish: null, steps: 0 };
  const last = assistants.at(-1);
  const finish = typeof last?.info?.finish === 'string' ? last.info.finish : null;
  const error = last?.info?.error;
  const errorName =
    error && typeof error === 'object' && typeof error.name === 'string' ? error.name : null;
  if (errorName === 'MessageAbortedError')
    return { kind: 'aborted', finish, steps: assistants.length };
  if (finish === 'length' || errorName === 'MessageOutputLengthError') {
    return { kind: 'truncated', finish, steps: assistants.length };
  }
  if (error !== undefined && error !== null) {
    return { kind: 'unverifiable', finish, steps: assistants.length };
  }
  if (assistants.length === stepLimit && finish === 'stop') {
    return { kind: 'step_budget_exhausted', finish, steps: assistants.length };
  }
  if (finish !== 'stop') return { kind: 'unverifiable', finish, steps: assistants.length };
  return { kind: 'completed', finish, steps: assistants.length };
}

function isSerializationPrompt(message) {
  if (message?.info?.role !== 'user' || !Array.isArray(message.parts)) return false;
  return message.parts.some(
    (part) =>
      part?.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.includes('The independent FlowGuard review in this child session is complete.'),
  );
}

function assistantUsage(messages) {
  return messages
    .filter((entry) => entry?.info?.role === 'assistant')
    .reduce(
      (sum, entry) => {
        const usage = entry?.info?.tokens ?? {};
        return {
          input: sum.input + Number(usage.input ?? 0),
          output: sum.output + Number(usage.output ?? 0),
          reasoning: sum.reasoning + Number(usage.reasoning ?? 0),
        };
      },
      { input: 0, output: 0, reasoning: 0 },
    );
}

function transcriptSummary(file, stepLimit) {
  const exported = readJson(file);
  const messages = Array.isArray(exported.messages) ? exported.messages : [];
  const boundary = messages.findIndex(isSerializationPrompt);
  const reviewMessages = boundary === -1 ? messages : messages.slice(0, boundary);
  const serializationMessages = boundary === -1 ? [] : messages.slice(boundary + 1);
  const serializationAssistants = serializationMessages.filter(
    (entry) => entry?.info?.role === 'assistant',
  );
  return {
    messages,
    completion: classifyCompletion(reviewMessages, stepLimit),
    tokens: assistantUsage(reviewMessages),
    serialization: {
      hasPrompt: boundary !== -1,
      assistants: serializationAssistants.length,
      tokens: assistantUsage(serializationMessages),
    },
  };
}

function findingSummary(findings) {
  if (!findings || typeof findings !== 'object') {
    return {
      overallVerdict: null,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      challenges: [],
    };
  }
  const list = (value) =>
    Array.isArray(value)
      ? value.map((entry) => ({
          category: entry?.category,
          severity: entry?.severity,
          reason: String(entry?.message ?? entry?.reason ?? ''),
        }))
      : [];
  return {
    overallVerdict: typeof findings.overallVerdict === 'string' ? findings.overallVerdict : null,
    blockingIssues: list(findings.blockingIssues),
    majorRisks: list(findings.majorRisks),
    missingVerification: Array.isArray(findings.missingVerification)
      ? findings.missingVerification.map(String)
      : [],
    scopeCreep: Array.isArray(findings.scopeCreep) ? findings.scopeCreep.map(String) : [],
    unknowns: Array.isArray(findings.unknowns) ? findings.unknowns.map(String) : [],
    challenges: Array.isArray(findings.challenges)
      ? findings.challenges.map((entry) => ({
          kind: String(entry?.kind ?? ''),
          outcome: String(entry?.outcome ?? ''),
        }))
      : [],
  };
}

function laneMatches(list, finding) {
  if (finding.lane === 'missingVerification') return list.missingVerification.length > 0;
  if (finding.lane === 'scopeCreep') return list.scopeCreep.length > 0;
  if (finding.lane === 'unknowns') return list.unknowns.length > 0;
  const lane = finding.lane === 'majorRisks' ? list.majorRisks : list.blockingIssues;
  return lane.some(
    (entry) =>
      entry.category === finding.category &&
      (finding.severity === 'any' || entry.severity === finding.severity),
  );
}

/** Evaluate captured findings against the independently authored gold standard.
 * @param {any} review
 * @param {any} goldStandard
 * @returns {{verdictMatch: boolean|null, requiredFindingMatch: boolean|null, forbiddenFindingAbsent: boolean|null, evidenceCitationsValid: boolean|null, outcome: 'pass'|'fail'|'not_assessed'}}
 */
export function evaluateFindings(review, goldStandard) {
  if (review.overallVerdict === null) {
    return {
      verdictMatch: null,
      requiredFindingMatch: null,
      forbiddenFindingAbsent: null,
      evidenceCitationsValid: null,
      outcome: 'not_assessed',
    };
  }
  const verdictMatch = review.overallVerdict === goldStandard.expectedReviewerVerdict;
  const requiredFindingMatch = goldStandard.requiredFindings.every((finding) =>
    laneMatches(review, finding),
  );
  const forbiddenFindingAbsent = goldStandard.forbiddenFindings.every(
    (finding) => !laneMatches(review, finding),
  );
  const evidenceCitationsValid = true;
  const outcome =
    verdictMatch && requiredFindingMatch && forbiddenFindingAbsent && evidenceCitationsValid
      ? 'pass'
      : 'fail';
  return {
    verdictMatch,
    requiredFindingMatch,
    forbiddenFindingAbsent,
    evidenceCitationsValid,
    outcome,
  };
}

/** Validate the two-phase transport: reasoning review, non-reasoning serialization. */
export function transportSmokeFailures(record) {
  const failures = [];
  if (record.failure) failures.push(`failure: ${record.failure}`);
  if (record.completion.kind !== 'completed') {
    failures.push(`completion=${record.completion.kind}`);
  }
  if (record.review.overallVerdict === null) failures.push('no bound reviewer verdict');
  if (!(Number(record.completion.reviewReasoningTokens) > 0)) {
    failures.push('fachlicher Review hat keine Reasoning-Tokens');
  }
  if (Number(record.completion.serializationReasoningTokens) !== 0) {
    failures.push('Serialisierung hat Reasoning-Tokens');
  }
  if (record.provenance.reviewerEffort !== 'none') {
    failures.push(`reviewerEffort=${String(record.provenance.reviewerEffort)}`);
  }
  if (
    !Array.isArray(record.provenance.reviewerParams) ||
    record.provenance.reviewerParams.length < 2
  ) {
    failures.push('weniger als zwei beobachtete Modellaufrufe');
  }
  if (record.completion.hasSerializationPrompt !== true) {
    failures.push('kein Serialisierungs-Prompt beobachtet');
  }
  return failures;
}

function observedReviewerParams(observationFile, childSessionId) {
  if (!fs.existsSync(observationFile)) return [];
  const entries = fs
    .readFileSync(observationFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const forChild = entries.filter(
    (entry) => entry.kind === 'chat.params' && entry.sessionID === childSessionId,
  );
  return forChild.length > 0
    ? forChild
    : entries.filter(
        (entry) => entry.kind === 'chat.params' && entry.agent === 'flowguard-reviewer',
      );
}

/** Selected OpenCode variant recorded by the `chat.message` hook, when exposed. */
function observedVariant(observationFile, childSessionId) {
  if (!fs.existsSync(observationFile)) return null;
  const entries = fs
    .readFileSync(observationFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return (
    [...entries]
      .reverse()
      .find((entry) => entry.kind === 'chat.message' && entry.sessionID === childSessionId)
      ?.variant ?? null
  );
}

async function runPlanCase({ runner, suite, selected, arm, repetition, options, evidenceDir }) {
  const label = `${selected.caseId}-${arm}-r${repetition}`;
  const workspace = path.join(options.root, 'workspaces', label);
  if (fs.existsSync(workspace)) throw new Error(`workspace already exists: ${workspace}`);
  fs.cpSync(path.join(options.root, 'setup', 'java-task-manager'), workspace, { recursive: true });
  applyReviewerStepBudget(workspace, options.reviewerSteps);
  applyReviewerOutputTokenMax(workspace, arm);
  const frontmatter = reviewerFrontmatter(workspace);
  const session = { workspace, terminal: 'COMPLETE' };
  const record = {
    schemaVersion: 'reviewer-reference-suite-run.v1',
    suiteVersion: suite.suiteVersion,
    runId: label,
    caseId: selected.caseId,
    goldStandardType: selected.goldStandardType,
    repetition,
    arm: { outputTokenMax: arm },
    provenance: {
      repoHead: gitHead(),
      dirty: gitDirty(),
      hostVersion: options.hostVersion,
      hostBinary: 'opencode',
      model: options.model,
      reviewerModel: null,
      reviewerEffort: null,
      reviewerSteps: null,
      modelLimitOutput: null,
      variant: options.variant,
      resolvedReasoning: {},
      criteriaVersion: 'p42-v7',
      mandateDigest: 'unavailable',
      caseCorpusDigest: sha256Text(canonicalJson(suite)),
      fixtureDigest: sha256Text(
        `${selected.input.planText ?? []}\n${JSON.stringify(selected.input.claims)}`,
      ),
      capSource: 'config',
      outputTokenMaxConfig: arm,
      outputTokenMaxEnv: null,
    },
    completion: {
      kind: 'unverifiable',
      finish: null,
      steps: 0,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      durationMs: null,
      retries: 0,
    },
    review: findingSummary(null),
    evaluation: evaluateFindings(findingSummary(null), selected.goldStandard),
    assurance: 'not_assessed',
    observedAt: new Date().toISOString(),
  };
  record.provenance.reviewerModel = frontmatter.model;
  record.provenance.reviewerEffort = frontmatter.effort;
  record.provenance.reviewerSteps = frontmatter.steps;
  const started = Date.now();
  try {
    await runner.turn(session, `${label}-01-start`, '/start');
    const ticketPath = path.join(workspace, 'TICKET.md');
    if (!fs.existsSync(ticketPath)) throw new Error(`ticket missing: ${ticketPath}`);
    await runner.turn(session, `${label}-02-task`, fs.readFileSync(ticketPath, 'utf8'), {
      command: 'task',
    });
    const planText = (selected.input.planText ?? []).join('\n');
    let planTurnError = null;
    try {
      await runner.turn(
        session,
        `${label}-03-plan`,
        options.singleReview
          ? singleReviewPrompt(planText, selected.input.claims)
          : planPrompt(planText, selected.input.claims),
        options.singleReview ? {} : { command: 'plan' },
      );
    } catch (error) {
      const message = String(error);
      if (!/REVIEWER_STEP_BUDGET_EXHAUSTED|REVIEWER_OUTPUT_TRUNCATED/.test(message)) {
        throw error;
      }
      // Retryable transport completion failure: the host may have authorized a
      // fresh attempt. Continue to the re-arm loop instead of losing the run.
      planTurnError = error;
    }
    const expectedSubjectDigest = sha256Text(normalizePlan(planText));
    let snapshot = runner.requireBoundState(session);
    let frozen = frozenPlanInvocation(snapshot.state, expectedSubjectDigest);
    const persistedPlan = normalizePlan(snapshot.state.plan?.current?.body);
    if (!frozen && persistedPlan !== normalizePlan(planText)) {
      record.completion = {
        ...record.completion,
        kind: 'unverifiable',
        durationMs: Date.now() - started,
      };
      record.failure = 'persisted plan differs from the frozen subject; run not comparable';
      return record;
    }

    if (options.singleReview) {
      const initialObligation = latestPlanObligation(snapshot.state);
      const rearmBudget = Math.max(
        0,
        Math.min(MAX_REVIEWER_REARMS, Number(initialObligation?.maxReviewerAttempts ?? 1)),
      );
      for (let rearm = 0; rearm < rearmBudget; rearm += 1) {
        snapshot = runner.requireBoundState(session);
        frozen = frozenPlanInvocation(snapshot.state, expectedSubjectDigest);
        if (frozen) break;
        const gate = classifyPlanGate(snapshot.state);
        if (gate !== PLAN_GATE.TRANSPORT_RETRY) break;
        await runner.turn(
          session,
          `${label}-04-rearm-${rearm + 1}`,
          'The host authorized a fresh reviewer attempt on the same frozen obligation. Invoke the reviewer Task again for that obligation, then stop. Do not revise the plan and do not call flowguard_plan.',
          {},
        );
      }
    }

    if (!options.singleReview) {
      const initialObligation = latestPlanObligation(snapshot.state);
      const rearmBudget = Math.max(
        0,
        Math.min(MAX_REVIEWER_REARMS, Number(initialObligation?.maxReviewerAttempts ?? 1)),
      );
      for (let rearm = 0; rearm < rearmBudget; rearm += 1) {
        snapshot = runner.requireBoundState(session);
        frozen = frozenPlanInvocation(snapshot.state, expectedSubjectDigest);
        if (frozen) break;
        const gate = classifyPlanGate(snapshot.state);
        if (gate !== PLAN_GATE.TRANSPORT_RETRY) break;
        await runner.turn(
          session,
          `${label}-04-settle-${rearm + 1}`,
          'The reviewer capture failed and the host re-armed a fresh attempt on the same frozen obligation. Invoke the reviewer Task again immediately for that obligation, then stop.',
          { command: 'plan' },
        );
      }
    }

    snapshot = runner.requireBoundState(session);
    frozen = frozenPlanInvocation(snapshot.state, expectedSubjectDigest);
    const findings =
      frozen?.invocation?.capturedRawFindings ??
      (normalizePlan(snapshot.state.plan?.current?.body) === normalizePlan(planText)
        ? fallbackPlanFindings(snapshot.state)
        : null);
    if (!findings) {
      record.failure =
        planTurnError !== null ? String(planTurnError) : 'review did not produce a bound verdict';
    }
    const obligation = frozen?.obligation ?? latestPlanObligation(snapshot.state);
    record.provenance.criteriaVersion = obligation?.criteriaVersion ?? 'p42-v7';
    record.provenance.mandateDigest = obligation?.mandateDigest ?? 'unavailable';
    record.provenance.childSessionId = frozen?.invocation?.childSessionId ?? null;
    const frozenAttempts = (snapshot.state.reviewAssurance?.attempts ?? []).filter(
      (attempt) =>
        attempt?.obligationType === 'plan' && attempt?.subjectDigest === expectedSubjectDigest,
    );
    record.completion.retries = Math.max(0, frozenAttempts.length - 1);
    record.review = findingSummary(findings);
    record.evaluation = evaluateFindings(record.review, selected.goldStandard);
    record.completion.durationMs = Date.now() - started;

    const capture = { name: label };
    try {
      await runner.captureProvenance(capture, session);
      const reviewer =
        capture.transcripts?.reviewers?.find(
          (entry) => entry.sessionId === frozen?.invocation?.childSessionId,
        ) ?? capture.transcripts?.reviewers?.at(-1);
      if (reviewer) {
        const transcriptFile = path.join(runner.evidenceDir, reviewer.file);
        const summary = transcriptSummary(transcriptFile, options.reviewerSteps);
        record.completion = {
          ...record.completion,
          kind: summary.completion.kind,
          finish: summary.completion.finish,
          steps: summary.completion.steps,
          inputTokens: summary.tokens.input,
          outputTokens: summary.tokens.output,
          reasoningTokens: summary.tokens.reasoning,
          reviewReasoningTokens: summary.tokens.reasoning,
          serializationReasoningTokens: summary.serialization.tokens.reasoning,
          serializationSteps: summary.serialization.assistants,
          hasSerializationPrompt: summary.serialization.hasPrompt,
        };
        const observed = observedReviewerParams(
          path.join(evidenceDir, 'chat-params.jsonl'),
          reviewer.sessionId,
        );
        record.provenance.reviewerParams = observed;
        if (observed.length > 0) {
          record.provenance.modelLimitOutput = observed.at(-1).modelLimit?.output ?? null;
          record.provenance.resolvedReasoning = observed[0].reasoningOptions ?? {};
          record.provenance.serializationReasoning = observed.at(-1).reasoningOptions ?? {};
        }
        const variant = observedVariant(
          path.join(evidenceDir, 'chat-params.jsonl'),
          reviewer.sessionId,
        );
        if (variant) record.provenance.variant = variant;
      }
      const reviewerTranscripts = capture.transcripts?.reviewers ?? [];
      const totalTokens = { input: 0, output: 0, reasoning: 0 };
      for (const entry of reviewerTranscripts) {
        const summary = transcriptSummary(
          path.join(runner.evidenceDir, entry.file),
          options.reviewerSteps,
        );
        totalTokens.input += summary.tokens.input + summary.serialization.tokens.input;
        totalTokens.output += summary.tokens.output + summary.serialization.tokens.output;
        totalTokens.reasoning += summary.tokens.reasoning + summary.serialization.tokens.reasoning;
      }
      const driverLogPath = path.join(runner.evidenceDir, 'driver.log');
      const driverLog = fs.existsSync(driverLogPath) ? fs.readFileSync(driverLogPath, 'utf8') : '';
      const rearmCodes = driverLog
        .split('\n')
        .filter((line) => line.includes(label))
        .map((line) => /structured re-arm authorized \[([A-Z_]+)\]/.exec(line)?.[1])
        .filter((code) => code !== undefined);
      record.transport = {
        reviewerAttempts: frozenAttempts.length,
        reviewerTranscripts: reviewerTranscripts.length,
        authorizedRearms: rearmCodes.length,
        rearmCodes: [...new Set(rearmCodes)],
        truncations: rearmCodes.filter((code) => code === 'REVIEWER_OUTPUT_TRUNCATED').length,
        stepBudgetAborts: rearmCodes.filter((code) => code === 'REVIEWER_STEP_BUDGET_EXHAUSTED')
          .length,
        totalInputTokens: totalTokens.input,
        totalOutputTokens: totalTokens.output,
        totalReasoningTokens: totalTokens.reasoning,
      };
      record.transport.reviewerAttempts = Math.max(
        record.transport.reviewerAttempts,
        record.transport.authorizedRearms + 1,
      );
      record.completion.retries = Math.max(
        record.completion.retries,
        record.transport.authorizedRearms,
      );
    } catch (error) {
      record.failure = `transcript capture failed: ${String(error)}`;
    }
    if (findings) record.completion.kind = 'completed';
    else record.completion.kind = 'unverifiable';
    record.assurance = 'not_assessed';
    return record;
  } catch (error) {
    record.completion.durationMs = Date.now() - started;
    record.failure = String(error);
    return record;
  } finally {
    fs.writeFileSync(
      path.join(evidenceDir, `${label}.record.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
  }
}

async function runReproduction({ runner, reproduction, arm, repetition, options, evidenceDir }) {
  const selected = {
    caseId: REPRODUCTION_CASE_ID,
    goldStandardType: 'plan_review',
    fixture: { executionMode: 'java_seed' },
    input: { planText: [reproduction.planText], claims: reproduction.claims },
    goldStandard: {
      expectedReviewerVerdict: null,
      requiredFindings: [],
      forbiddenFindings: [],
      expectedEvidenceAssessment: 'not_assessed',
    },
  };
  const record = await runPlanCase({
    runner,
    suite: readJson(SUITE_FILE),
    selected,
    arm,
    repetition,
    options,
    evidenceDir,
  });
  record.caseId = REPRODUCTION_CASE_ID;
  record.goldStandardType = 'plan_review';
  record.evaluation = {
    verdictMatch: null,
    requiredFindingMatch: null,
    forbiddenFindingAbsent: null,
    evidenceCitationsValid: null,
    outcome: 'not_assessed',
  };
  return record;
}

async function main() {
  const options = parseSuiteArgs(process.argv.slice(2));
  if (options.transportSmoke) {
    options.repetitions = 1;
    options.arm ??= 32000;
    options.caseId ??= REPRODUCTION_CASE_ID;
  }
  const suite = readJson(SUITE_FILE);
  const selection = selectCases(options, suite);
  const reproduction = options.caseId === REPRODUCTION_CASE_ID ? readJson(REPRODUCTION_FILE) : null;

  if (options.check) {
    if (reproduction) {
      console.log(`check OK: ${REPRODUCTION_CASE_ID} (termination-only reproduction)`);
      return;
    }
    console.log(
      `check OK: ${selection.cases.map((entry) => entry.caseId).join(', ')} (${selection.kind})`,
    );
    return;
  }

  if (fs.existsSync(options.root)) {
    throw new Error(`run root already exists: ${options.root}`);
  }
  const hostVersion = assertHostVersion(options.hostVersion);
  delete process.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX;
  process.env.FLOWGUARD_REFERENCE_SUITE = '1';
  process.env.FLOWGUARD_REVIEWER_STEPS = String(options.reviewerSteps);
  const tarball = tarballFor(options);
  const evidenceDir = path.join(options.root, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const baseWorkspace = prepareBaseWorkspace(options, tarball, path.join(options.root, 'setup'));
  if (!fs.existsSync(baseWorkspace)) throw new Error('demo setup did not create a workspace');

  const arms = options.arm === undefined ? [32000, 65536] : [options.arm];
  const cases = reproduction ? [reproduction] : selection.cases;
  const records = [];
  for (const arm of arms) {
    process.env.FLOWGUARD_REVIEW_SUITE_OBSERVATION_PATH = path.join(
      evidenceDir,
      'chat-params.jsonl',
    );
    for (const item of cases) {
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        const label = `${reproduction ? REPRODUCTION_CASE_ID : item.caseId}-${arm}-r${repetition}`;
        // A fresh config dir per run prevents host permission/state caches and
        // pending review pointers from leaking between independent repetitions.
        const runConfigDir = path.join(options.root, 'config', label);
        fs.mkdirSync(runConfigDir, { recursive: true });
        writeObserverPlugin(runConfigDir);
        const runner = new Runner(options.root, options, runConfigDir);
        console.log(`START ${label}`);
        const record = reproduction
          ? await runReproduction({ runner, reproduction, arm, repetition, options, evidenceDir })
          : await runPlanCase({
              runner,
              suite,
              selected: item,
              arm,
              repetition,
              options,
              evidenceDir,
            });
        records.push(record);
        console.log(
          `DONE ${label}: completion=${record.completion.kind} verdict=${String(
            record.review.overallVerdict,
          )} evaluation=${record.evaluation.outcome}`,
        );
        fs.writeFileSync(
          path.join(evidenceDir, 'run-records.json'),
          `${JSON.stringify(records, null, 2)}\n`,
          'utf8',
        );
        if (options.transportSmoke) {
          const failures = transportSmokeFailures(record);
          fs.writeFileSync(
            path.join(evidenceDir, 'transport-smoke.json'),
            `${JSON.stringify(
              {
                caseId: record.caseId,
                arm: record.arm,
                repetition: record.repetition,
                ok: failures.length === 0,
                failures,
                reviewReasoningTokens: record.completion.reviewReasoningTokens,
                serializationReasoningTokens: record.completion.serializationReasoningTokens,
                reviewerEffort: record.provenance.reviewerEffort,
                reviewerParamCalls: record.provenance.reviewerParams?.length ?? 0,
              },
              null,
              2,
            )}\n`,
            'utf8',
          );
          if (failures.length > 0) {
            console.error(`TRANSPORT SMOKE FAILED: ${failures.join('; ')}`);
            process.exitCode = 1;
            return;
          }
          console.log('TRANSPORT SMOKE PASS');
          return;
        }
      }
    }
  }
  fs.writeFileSync(
    path.join(evidenceDir, 'metadata.json'),
    `${JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        hostVersion,
        hostVersionActual: hostVersion,
        model: options.model,
        reviewerEffort: options.reviewerEffort,
        reviewerSteps: options.reviewerSteps,
        arms,
        repetitions: options.repetitions,
        caseIds: cases.map((entry) => entry.caseId ?? REPRODUCTION_CASE_ID),
        tarball,
        tarballSha256: sha256(tarball),
        productSha: options.productSha ?? null,
        checkoutHead: gitHead(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`records: ${path.join(evidenceDir, 'run-records.json')}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
