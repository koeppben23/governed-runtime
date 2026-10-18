#!/usr/bin/env node
/**
 * @module demos/lib/review-navigation-benchmark
 * @description Paired forensic analysis for the DREP prompt experiment.
 *
 * Reads only what the live runner already wrote. It verifies the prompt variant
 * from each reviewer child's actual first user message, reconstructs per-attempt
 * metrics from the child export and persisted review assurance state, and never
 * converts missing data into zero seconds.
 *
 * Usage:
 *   node demos/lib/review-navigation-benchmark.mjs --root <r1> --root <r2> \
 *     [--quality-result <json>] [--json <file>] [--md <file>]
 *
 * @version v1
 */

import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from './is-main-module.mjs';

export const NAVIGATION_PROMPT_MARKER = '### Review Navigation (host instruction)';
export const NOT_VERIFIED = 'NOT_VERIFIED';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return NOT_VERIFIED;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function textOf(message) {
  return (message?.parts ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
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

function readChildExport(root, file) {
  return readJson(path.join(root, 'evidence', file));
}

/**
 * One reviewer child: verify the variant from the actual prompt and collect
 * attempt-bound metrics. Missing evidence stays NOT_VERIFIED, never 0.
 */
export function analyzeReviewerChild(input) {
  const { root, variant, flow, transcript, state } = input;
  const child = readChildExport(root, transcript.file);
  const messages = Array.isArray(child?.messages) ? child.messages : null;
  const firstUser = messages?.find((message) => message?.info?.role === 'user');
  const prompt = firstUser ? textOf(firstUser) : '';
  const hasInstruction = prompt.includes(NAVIGATION_PROMPT_MARKER);
  const hasIndex = prompt.includes('review-navigation.v1');
  const variantApplied = variant === 'on' ? hasInstruction : !hasInstruction;
  const firstAt = firstUser?.info?.time?.created;
  const assistant = (messages ?? []).filter((message) => message?.info?.role === 'assistant');
  const lastAssistant = assistant.at(-1);
  const lastAt = lastAssistant?.info?.time?.completed;
  const elapsedMs =
    Number.isFinite(firstAt) && Number.isFinite(lastAt) ? Math.max(0, lastAt - firstAt) : null;

  const invocation = (state?.reviewAssurance?.invocations ?? [])
    .filter((entry) => entry.childSessionId === transcript.sessionId)
    .at(-1);
  const attempt =
    (state?.reviewAssurance?.attempts ?? []).find(
      (entry) =>
        entry.attemptId === invocation?.attemptId ||
        (invocation === undefined && entry.childSessionId === transcript.sessionId),
    ) ?? null;
  const obligation = (state?.reviewAssurance?.obligations ?? []).find(
    (entry) => entry.obligationId === (invocation?.obligationId ?? attempt?.obligationId),
  );
  const type = invocation?.obligationType ?? attempt?.obligationType ?? null;
  const verdict = invocation?.capturedVerdict ?? null;
  const valid =
    type !== null &&
    attempt?.status === 'bound' &&
    typeof invocation?.invokedAt === 'string' &&
    typeof invocation?.fulfilledAt === 'string' &&
    verdict !== 'unable_to_review';
  const validMs = valid
    ? Math.max(0, Date.parse(invocation.fulfilledAt) - Date.parse(invocation.invokedAt))
    : null;

  let tokens = 0;
  let cost = 0;
  for (const message of assistant) {
    const info = message.info ?? {};
    tokens += Number(info.tokens?.total ?? 0);
    cost += Number(info.cost ?? 0);
  }
  const observations = messages
    ? messages
        .flatMap((message) => message.parts ?? [])
        .filter((part) => part?.type === 'tool' && part.tool === 'flowguard_observe_repository')
        .length
    : null;

  return {
    root,
    flow: flow.name,
    variant,
    childSessionId: transcript.sessionId,
    type,
    valid,
    validMs,
    elapsedMs,
    verdict,
    variantApplied,
    variantMismatch: false,
    indexPresent: hasIndex,
    promptChars: prompt.length,
    indexChars: hasIndex
      ? (prompt.split('\n').find((line) => line.includes('review-navigation.v1'))?.length ?? null)
      : null,
    steps: messages ? assistant.length : null,
    observations,
    tokens: messages ? tokens : null,
    cost: messages ? Number(cost.toFixed(6)) : null,
    obligationStatus: obligation?.status ?? null,
    rearmCount: (state?.reviewAssurance?.attempts ?? []).filter(
      (entry) =>
        entry.obligationId === (invocation?.obligationId ?? attempt?.obligationId) &&
        entry.origin?.kind === 'dispatch_rearm',
    ).length,
  };
}

export function analyzeRoot(root) {
  const metadata = readJson(path.join(root, 'evidence', 'metadata.json'));
  const flows = readJson(path.join(root, 'evidence', 'flows.json'));
  if (
    metadata === undefined ||
    !Array.isArray(flows) ||
    (metadata.reviewNavigation !== 'on' && metadata.reviewNavigation !== 'off')
  ) {
    return { root, notVerified: 'metadata_or_variant_missing', entries: [] };
  }
  const entries = [];
  const notVerified = [];
  for (const flow of flows) {
    const parent = flow.hostSessionId;
    const state = parent ? findState(root, parent) : undefined;
    if (state === undefined) {
      notVerified.push({ flow: flow.name, reason: 'session_state_missing' });
      continue;
    }
    for (const transcript of flow.transcripts?.reviewers ?? []) {
      const entry = analyzeReviewerChild({
        root,
        variant: metadata.reviewNavigation,
        flow,
        transcript,
        state,
      });
      if (!entry.variantApplied) entry.variantMismatch = true;
      entries.push(entry);
    }
  }
  return {
    root,
    pairId: metadata.pairId ?? null,
    variant: metadata.reviewNavigation,
    buildSha: metadata.installedBuild?.gitSha ?? metadata.tarballSha256 ?? null,
    hostVersion: metadata.pins?.hostVersion ?? null,
    model: metadata.model ?? null,
    harnessVersion: metadata.harnessVersion ?? null,
    notVerified,
    entries,
  };
}

export function summarize(roots, qualityResult) {
  const entries = roots.flatMap((root) => root.entries).filter((entry) => entry.type !== null);
  const types = ['plan', 'implement'];
  const summary = [];
  for (const type of types) {
    for (const variant of ['off', 'on']) {
      const group = entries.filter((entry) => entry.type === type && entry.variant === variant);
      const valid = group.filter((entry) => entry.valid);
      const invalid = group.filter((entry) => !entry.valid);
      summary.push({
        type,
        variant,
        children: group.length,
        valid: valid.length,
        invalid: invalid.length,
        variantMismatches: group.filter((entry) => entry.variantMismatch).length,
        indexPresent: group.filter((entry) => entry.indexPresent).length,
        medianValidMs: median(valid.map((entry) => entry.validMs)),
        medianInvalidElapsedMs: median(invalid.map((entry) => entry.elapsedMs)),
        medianSteps: median(group.map((entry) => entry.steps)),
        medianObservations: median(group.map((entry) => entry.observations)),
        medianTokens: median(group.map((entry) => entry.tokens)),
        medianCost: median(group.map((entry) => entry.cost)),
        medianPromptChars: median(group.map((entry) => entry.promptChars)),
        medianIndexChars: median(group.map((entry) => entry.indexChars)),
        rearmCount: group.reduce((total, entry) => total + entry.rearmCount, 0),
        notVerified:
          group.length === 0 ||
          group.some((entry) => entry.variantMismatch) ||
          group.some((entry) => entry.validMs === null && entry.elapsedMs === null),
      });
    }
  }
  const pairs = [];
  for (const root of roots.filter((entry) => entry.pairId !== null)) {
    const pairRoots = roots.filter(
      (candidate) => candidate.pairId === root.pairId && candidate.buildSha === root.buildSha,
    );
    for (const type of types) {
      const off = pairRoots
        .find((candidate) => candidate.variant === 'off')
        ?.entries.find((entry) => entry.type === type && entry.valid);
      const on = pairRoots
        .find((candidate) => candidate.variant === 'on')
        ?.entries.find((entry) => entry.type === type && entry.valid);
      if (off === undefined || on === undefined) continue;
      pairs.push({
        pairId: root.pairId,
        type,
        offMs: off.validMs,
        onMs: on.validMs,
        deltaMs: on.validMs - off.validMs,
      });
    }
  }
  const groupedPairs = new Map();
  for (const pair of pairs) groupedPairs.set(`${pair.pairId}:${pair.type}`, pair);
  const uniquePairs = [...groupedPairs.values()];
  const byType = Object.fromEntries(
    types.map((type) => {
      const pairsOfType = uniquePairs.filter((pair) => pair.type === type);
      return [
        type,
        {
          pairs: pairsOfType.length,
          medianDeltaMs: median(pairsOfType.map((pair) => pair.deltaMs)),
          relativeImprovement:
            pairsOfType.length === 0
              ? NOT_VERIFIED
              : median(
                  pairsOfType.map((pair) =>
                    pair.offMs > 0 ? (pair.offMs - pair.onMs) / pair.offMs : null,
                  ),
                ),
        },
      ];
    }),
  );
  return {
    version: 'review-navigation-benchmark.v1',
    roots: roots.length,
    summary,
    pairs: uniquePairs,
    pairSummary: byType,
    qualityGate: qualityResult ?? NOT_VERIFIED,
    notVerified: roots.flatMap((root) => root.notVerified),
  };
}

function renderMarkdown(result) {
  const lines = [
    '# DREP review-navigation A/B benchmark',
    '',
    'Only measured values are shown; missing data is `NOT_VERIFIED`, never zero.',
    '',
    '| Type | Variant | Children | Valid | Invalid | Median valid ms | Median invalid elapsed ms | Steps | Observations | Tokens | Variant mismatches |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of result.summary) {
    lines.push(
      `| ${row.type} | ${row.variant} | ${row.children} | ${row.valid} | ${row.invalid} | ${row.medianValidMs} | ${row.medianInvalidElapsedMs} | ${row.medianSteps} | ${row.medianObservations} | ${row.medianTokens} | ${row.variantMismatches} |`,
    );
  }
  lines.push('', '## Paired delta', '');
  for (const type of ['plan', 'implement']) {
    const pair = result.pairSummary[type];
    lines.push(
      `- ${type}: ${pair.pairs} pairs; median delta ${pair.medianDeltaMs} ms; relative improvement ${pair.relativeImprovement}`,
    );
  }
  lines.push('', '## Quality gate', '', `- ${String(result.qualityGate)}`, '');
  if (result.notVerified.length > 0) {
    lines.push('## NOT_VERIFIED', '', JSON.stringify(result.notVerified), '');
  }
  return `${lines.join('\n')}\n`;
}

export function runAnalysis({ roots, qualityResult }) {
  const analyzed = roots.map(analyzeRoot);
  const result = summarize(analyzed, qualityResult);
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
    else if (flag === '--quality-result') options.qualityResultFile = path.resolve(next());
    else if (flag === '--json') options.jsonFile = path.resolve(next());
    else if (flag === '--md') options.mdFile = path.resolve(next());
    else throw new Error(`unknown option: ${flag}`);
  }
  if (options.roots.length === 0) throw new Error('at least one --root is required');
  return options;
}

if (isMainModule(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const qualityResult =
    options.qualityResultFile === undefined ? undefined : readJson(options.qualityResultFile);
  const { result, markdown } = runAnalysis({ roots: options.roots, qualityResult });
  if (options.jsonFile !== undefined) {
    fs.writeFileSync(options.jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (options.mdFile !== undefined) {
    fs.writeFileSync(options.mdFile, markdown);
  }
  process.stdout.write(markdown);
}
