#!/usr/bin/env node
/**
 * @module demos/lib/review-latency
 * @description End-to-end review latency per persisted review obligation.
 *
 * The unit of measurement is one obligation from its first recorded attempt to
 * the terminal review outcome, including every discarded attempt and re-arm in
 * between. A bound but `unable_to_review` result is not a valid review; missing
 * timings are NOT_VERIFIED, never zero. The analyzer is independent of the DREP
 * experiment and of any prompt variant.
 *
 * Usage:
 *   node demos/lib/review-latency.mjs --root <root> [--root <root>...] \
 *     [--json <file>] [--md <file>]
 *
 * @version v1
 */

import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from './is-main-module.mjs';

export const NOT_VERIFIED = 'NOT_VERIFIED';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function timeOf(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return NOT_VERIFIED;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Pure projection of one persisted SessionState into per-obligation review
 * latency. The last bound invocation supplies the terminal timestamp; every
 * attempt of the same obligation is included in the elapsed window.
 */
export function analyzeReviewObligations(state) {
  const assurance = state?.reviewAssurance ?? {};
  const obligations = assurance.obligations ?? [];
  const attempts = assurance.attempts ?? [];
  const invocations = assurance.invocations ?? [];

  return obligations.map((obligation) => {
    const ownAttempts = attempts
      .filter((attempt) => attempt.obligationId === obligation.obligationId)
      .sort(
        (left, right) =>
          (left.ordinal ?? 0) - (right.ordinal ?? 0) ||
          (timeOf(left.createdAt) ?? 0) - (timeOf(right.createdAt) ?? 0),
      );
    const ownInvocations = invocations.filter(
      (invocation) => invocation.obligationId === obligation.obligationId,
    );
    const startTimes = ownAttempts
      .map((attempt) => timeOf(attempt.createdAt))
      .filter((value) => value !== null);
    const firstStartedAt = startTimes.length === 0 ? null : Math.min(...startTimes);
    const boundAttempt = ownAttempts.find((attempt) => attempt.status === 'bound') ?? null;
    const invocation =
      ownInvocations.find((entry) => entry.attemptId === boundAttempt?.attemptId) ?? null;
    const completedTimes = ownAttempts
      .map((attempt) => timeOf(attempt.completedAt))
      .filter((value) => value !== null);
    const terminalAt = invocation
      ? timeOf(invocation.fulfilledAt)
      : completedTimes.length === 0
        ? null
        : Math.max(...completedTimes);
    const timeToTerminalMs =
      firstStartedAt !== null && terminalAt !== null
        ? Math.max(0, terminalAt - firstStartedAt)
        : null;
    const verdict = invocation?.capturedVerdict ?? null;
    const valid =
      boundAttempt !== null &&
      invocation !== null &&
      verdict !== null &&
      verdict !== 'unable_to_review';
    const terminal = boundAttempt
      ? valid
        ? 'valid'
        : 'invalid'
      : obligation.status === 'blocked'
        ? 'blocked'
        : ownAttempts.some((attempt) => attempt.status === 'created')
          ? 'pending'
          : 'not_verified';
    const rearmAttemptIds = [
      ...new Set(
        ownAttempts
          .filter((attempt) => attempt.origin?.kind === 'dispatch_rearm')
          .map((attempt) => attempt.attemptId),
      ),
    ];

    return {
      obligationId: obligation.obligationId,
      type: obligation.obligationType,
      obligationStatus: obligation.status,
      terminal,
      valid,
      verdict,
      firstStartedAt,
      terminalAt,
      timeToTerminalMs,
      attemptCount: ownAttempts.length,
      rearmAttemptIds,
      attempts: ownAttempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        ordinal: attempt.ordinal ?? null,
        status: attempt.status,
        origin: attempt.origin?.kind ?? null,
        childSessionId: attempt.childSessionId ?? null,
        createdAt: attempt.createdAt ?? null,
        completedAt: attempt.completedAt ?? null,
      })),
    };
  });
}

function findState(root, parentSessionId) {
  const workspaces = path.join(root, 'config', 'workspaces');
  if (!fs.existsSync(workspaces)) return undefined;
  for (const fingerprint of fs.readdirSync(workspaces)) {
    const file = path.join(
      workspaces,
      fingerprint,
      'sessions',
      parentSessionId,
      'session-state.json',
    );
    const state = readJson(file);
    if (state !== undefined) return state;
  }
  return undefined;
}

export function analyzeRoot(root) {
  const flows = readJson(path.join(root, 'evidence', 'flows.json'));
  const sessions = Array.isArray(flows)
    ? [...new Set(flows.map((flow) => flow.hostSessionId).filter(Boolean))]
    : [];
  const reviews = [];
  const notVerified = [];
  if (sessions.length === 0) notVerified.push({ root, reason: 'no_parent_sessions' });
  for (const sessionId of sessions) {
    const state = findState(root, sessionId);
    if (state === undefined) {
      notVerified.push({ root, sessionId, reason: 'session_state_missing' });
      continue;
    }
    for (const review of analyzeReviewObligations(state)) reviews.push(review);
  }
  return { root, reviews, notVerified };
}

export function summarize(reviews) {
  const types = ['plan', 'implement', 'architecture', 'review'];
  return types.map((type) => {
    const group = reviews.filter((review) => review.type === type);
    const valid = group.filter((review) => review.valid);
    const invalid = group.filter((review) => review.terminal === 'invalid');
    const terminalWithoutTime = group.filter(
      (review) => review.timeToTerminalMs === null && review.terminal !== 'pending',
    );
    const rearmKeys = new Set(
      group.flatMap((review) =>
        review.rearmAttemptIds.map((attemptId) => `${review.obligationId}:${attemptId}`),
      ),
    );
    return {
      type,
      obligations: group.length,
      valid: valid.length,
      invalid: invalid.length,
      blocked: group.filter((review) => review.terminal === 'blocked').length,
      pending: group.filter((review) => review.terminal === 'pending').length,
      notVerified: group.filter((review) => review.terminal === 'not_verified').length,
      medianTimeToValidMs: median(valid.map((review) => review.timeToTerminalMs)),
      medianInvalidElapsedMs: median(
        group.filter((review) => !review.valid).map((review) => review.timeToTerminalMs),
      ),
      totalAttempts: group.reduce((total, review) => total + review.attemptCount, 0),
      rearmCount: rearmKeys.size,
      missingTiming: terminalWithoutTime.length,
    };
  });
}

function renderMarkdown(result) {
  const lines = [
    '# Review latency (end-to-end per obligation)',
    '',
    'Elapsed time runs from the first recorded attempt to the terminal review outcome, including discarded attempts and re-arms. `NOT_VERIFIED`/invalid reviews are not counted as fast valid reviews.',
    '',
    '| Type | Obligations | Valid | Invalid | Blocked | Pending | NOT_VERIFIED | Median valid ms | Median invalid ms | Attempts | Re-arms (unique) | Missing timing |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of result.summary) {
    lines.push(
      `| ${row.type} | ${row.obligations} | ${row.valid} | ${row.invalid} | ${row.blocked} | ${row.pending} | ${row.notVerified} | ${row.medianTimeToValidMs} | ${row.medianInvalidElapsedMs} | ${row.totalAttempts} | ${row.rearmCount} | ${row.missingTiming} |`,
    );
  }
  if (result.notVerified.length > 0) {
    lines.push('', '## NOT_VERIFIED', '', JSON.stringify(result.notVerified), '');
  }
  return `${lines.join('\n')}\n`;
}

export function runAnalysis(roots) {
  const analyzed = roots.map(analyzeRoot);
  const reviews = analyzed.flatMap((entry) => entry.reviews);
  const result = {
    version: 'review-latency.v1',
    roots: analyzed.length,
    reviews,
    summary: summarize(reviews),
    notVerified: analyzed.flatMap((entry) => entry.notVerified),
  };
  return { result, markdown: renderMarkdown(result) };
}

function parseArgs(argv) {
  const options = { roots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (flag === '--root') options.roots.push(path.resolve(next()));
    else if (flag === '--json') options.jsonFile = path.resolve(next());
    else if (flag === '--md') options.mdFile = path.resolve(next());
    else throw new Error(`unknown option: ${flag}`);
  }
  if (options.roots.length === 0) throw new Error('at least one --root is required');
  return options;
}

if (isMainModule(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const { result, markdown } = runAnalysis(options.roots);
  if (options.jsonFile !== undefined) {
    fs.writeFileSync(options.jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (options.mdFile !== undefined) fs.writeFileSync(options.mdFile, markdown);
  process.stdout.write(markdown);
}
