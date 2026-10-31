#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';
import { ProbeError } from '../lib/isolation.mjs';
import {
  exactReviewerRequest,
  exactTerminalForPrompt,
  lastUserText,
  latestAssistantText,
  normalTerminal,
  reviewerRequests,
  toolParts,
} from '../lib/review-evidence.mjs';
import { nativeChildReference } from '../lib/scope-evidence.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/phase02/p0-reviewer');
await mkdir(outDir, { recursive: true });
const runDir = join(outDir, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(runDir);

function sessionID(headers) {
  const value = headers?.['x-opencode-session-id'];
  return Array.isArray(value) ? value[0] : value;
}
function hasToolResult(body) {
  return body?.messages?.some((message) => message.role === 'tool') ?? false;
}
let parentID;
let reviewWithToolRequests = 0;
function script(body, _index, meta) {
  const sid = sessionID(meta?.headers);
  const text = lastUserText(body);
  if (text.includes('PARENT_REVIEW_REQUEST')) parentID = sid;
  if (sid === parentID) {
    if (text.includes('REVIEW_WITH_TOOL')) {
      reviewWithToolRequests += 1;
      if (reviewWithToolRequests <= 3) {
        return {
          tool: {
            name: 'subagent',
            arguments: {
              agent: 'probe-reviewer',
              description: 'tool-attempt reviewer',
              prompt: 'RETURN_REVIEW_WITH_TOOL',
            },
          },
          finish: 'tool_calls',
        };
      }
      return { text: 'PARENT_REVIEW_LOOP_GUARD', finish: 'stop' };
    }
    if (hasToolResult(body)) return { text: 'PARENT_REVIEW_DONE', finish: 'stop' };
    return {
      tool: {
        name: 'subagent',
        arguments: {
          agent: 'probe-reviewer',
          description: 'simple reviewer',
          prompt: 'RETURN_REVIEW_TERMINAL',
        },
      },
      finish: 'tool_calls',
    };
  }
  if (text.includes('RETURN_REVIEW_WITH_TOOL')) {
    if (hasToolResult(body)) return { text: 'REVIEW_WITH_TOOL_TERMINAL', finish: 'stop' };
    return { tool: { name: 'probe_echo', arguments: { text: 'reviewer-tool-attempt' } } };
  }
  if (text.includes('FORGED_AFTER_TERMINAL'))
    return { text: 'FORGED_AFTER_TERMINAL', finish: 'stop' };
  return { text: 'REVIEW_TERMINAL', finish: 'stop' };
}

function childParts(context, prompt) {
  return context.flatMap((message) =>
    message.type === 'assistant'
      ? (message.content ?? [])
          .filter(
            (part) =>
              part.type === 'tool' &&
              part.name === 'subagent' &&
              part.state?.input?.prompt === prompt,
          )
          .map((part) => ({ messageID: message.id, part }))
      : [],
  );
}

function childForPrompt(context, prompt) {
  const parts = childParts(context, prompt).filter(
    ({ part }) => part.state?.status === 'completed',
  );
  if (parts.length !== 1)
    throw new ProbeError(
      'PROBE_REVIEWER_CHILD_AMBIGUOUS',
      `Expected one completed native reviewer for ${prompt}, got ${parts.length}`,
    );
  const sessionID = parts[0].part.state?.metadata?.sessionID;
  if (typeof sessionID !== 'string')
    throw new ProbeError(
      'PROBE_REVIEWER_CHILD_MISSING',
      'Native reviewer metadata lacks sessionID',
    );
  return { sessionID, toolCallID: parts[0].part.id, assistantMessageID: parts[0].messageID };
}

async function wait(host, sessionID) {
  await host.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
}

async function waitBounded(host, sessionID, timeoutMs = 8_000) {
  try {
    await host.client.session.wait({ sessionID }, { signal: AbortSignal.timeout(timeoutMs) });
    return { returned: true };
  } catch (error) {
    return { returned: false, error: String(error) };
  }
}

const host = await startProbeHost({ name: 'p0-reviewer', denyTools: ['probe_echo'], script });
const report = {
  at: new Date().toISOString(),
  surface: 'macOS private CLI/server 2.2.4; deterministic provider; SDK-triggered native subagent',
  p005: 'NOT_VERIFIED',
  p001: 'BLOCKED',
  decision: 'NO-GO',
  simple: null,
  forgedReuse: null,
  toolAttempt: null,
  error: null,
  cleanup: null,
  sourceSha256: {},
};
let childID;
try {
  await host.activate();
  const parent = await host.client.session.create({
    title: 'reviewer parent',
    model: { providerID: 'probe', id: 'probe', variant: 'chosen' },
    location: { directory: host.project },
  });
  report.parentID = parent.id;
  await host.prompt(parent.id, 'PARENT_REVIEW_REQUEST');
  await wait(host, parent.id);
  const parentContext = await host.client.session.context({ sessionID: parent.id });
  const reference = childForPrompt(parentContext, 'RETURN_REVIEW_TERMINAL');
  childID = reference.sessionID;
  const child = await host.client.session.get({ sessionID: childID });
  const childContext = await host.client.session.context({ sessionID: childID });
  const terminal = exactTerminalForPrompt(
    childContext,
    'RETURN_REVIEW_TERMINAL',
    'REVIEW_TERMINAL',
  );
  const request = exactReviewerRequest(host.provider.requests, childID, 'RETURN_REVIEW_TERMINAL');
  const childRequests = reviewerRequests(host.provider.requests, childID);
  report.simple = {
    child,
    terminal,
    request,
    childRequestCount: childRequests.length,
    toolParts: toolParts(childContext).length,
    hasToolResult: childContext.some((message) => message.type === 'tool'),
    parentTerminal: normalTerminal(parentContext, 'PARENT_REVIEW_DONE'),
    parentToolCallID: reference.toolCallID,
    parentAssistantMessageID: reference.assistantMessageID,
    chainValid:
      child.parentID === parent.id &&
      child.agent === 'probe-reviewer' &&
      childRequests.length === 1 &&
      toolParts(childContext).length === 0 &&
      terminal.toolParts === 0 &&
      normalTerminal(parentContext, 'PARENT_REVIEW_DONE'),
    assuranceValid:
      child.parentID === parent.id &&
      child.agent === 'probe-reviewer' &&
      child.model?.providerID === 'probe' &&
      child.model?.id === 'probe' &&
      child.model?.variant === 'chosen' &&
      request.model === 'probe' &&
      request.reasoningEffort === 'high' &&
      childRequests.length === 1 &&
      toolParts(childContext).length === 0 &&
      terminal.toolParts === 0 &&
      normalTerminal(parentContext, 'PARENT_REVIEW_DONE'),
  };

  // The host permits direct continuation of the same child after its terminal.
  await host.client.session.prompt({
    sessionID: childID,
    text: 'FORGED_AFTER_TERMINAL',
    delivery: 'queue',
  });
  await wait(host, childID);
  const reusedContext = await host.client.session.context({ sessionID: childID });
  const originalAgain = exactTerminalForPrompt(
    reusedContext,
    'RETURN_REVIEW_TERMINAL',
    'REVIEW_TERMINAL',
  );
  report.forgedReuse = {
    hostAccepted: reusedContext.filter((message) => message.type === 'user').length === 2,
    latestAssistantText: latestAssistantText(reusedContext),
    originalTerminalStillBound: originalAgain.messageID === terminal.messageID,
    exactChainRemainsOriginal: originalAgain.text === 'REVIEW_TERMINAL',
    naiveLatestIsForged: latestAssistantText(reusedContext) === 'FORGED_AFTER_TERMINAL',
    requestCount: reviewerRequests(host.provider.requests, childID).length,
  };

  await host.prompt(parent.id, 'REVIEW_WITH_TOOL');
  const parentWait = await waitBounded(host, parent.id);
  const parentContext2 = await host.client.session.context({ sessionID: parent.id });
  const toolParts2 = childParts(parentContext2, 'RETURN_REVIEW_WITH_TOOL');
  const toolPart = toolParts2.at(-1)?.part;
  const knownIDs = new Set([parent.id, childID]);
  const candidateID = host.provider.requests
    .map((request) => request.headers?.['x-opencode-session-id'])
    .find((id) => typeof id === 'string' && id.length > 0 && !knownIDs.has(id));
  const child2ID = toolPart?.state?.metadata?.sessionID ?? candidateID;
  let child2 = null;
  let child2Context = [];
  let child2Requests = [];
  let child2Error = null;
  if (child2ID) {
    try {
      child2 = await host.client.session.get({ sessionID: child2ID });
      child2Context = await host.client.session.context({ sessionID: child2ID });
      child2Requests = reviewerRequests(host.provider.requests, child2ID);
    } catch (error) {
      child2Error = String(error);
    }
  }
  const entries = await host.entries();
  const terminal2 = child2Context.some(
    (message) =>
      message.type === 'assistant' &&
      message.finish === 'stop' &&
      (message.content ?? []).some(
        (part) => part.type === 'text' && part.text === 'REVIEW_WITH_TOOL_TERMINAL',
      ),
  );
  const tools2 = toolParts(child2Context);
  report.toolAttempt = {
    childID: child2ID ?? null,
    parentWait,
    parentToolStatus: toolPart?.state?.status ?? null,
    parentToolPartCount: toolParts2.length,
    parentRequestCount: host.provider.requests.filter(
      (request) =>
        request.headers?.['x-opencode-session-id'] === parent.id &&
        lastUserText(request.body).includes('REVIEW_WITH_TOOL'),
    ).length,
    loopGuardTriggered: reviewWithToolRequests > 3,
    child: child2
      ? { id: child2.id, parentID: child2.parentID, outcome: child2.outcome ?? null }
      : null,
    childError: child2Error,
    toolParts: tools2.map((part) => ({
      name: part.name,
      status: part.state?.status,
      input: part.state?.input,
    })),
    toolExecuted: entries.some((entry) => entry.type === 'tool:probe_echo'),
    terminal: terminal2,
    requestCount: child2Requests.length,
    reasoningEfforts: child2Requests.map((request) => request.body?.reasoning_effort),
    childToolAttemptObserved:
      child2?.parentID === parent.id &&
      tools2.length > 0 &&
      !entries.some((entry) => entry.type === 'tool:probe_echo') &&
      terminal2,
    flowCompleted:
      parentWait.returned === true &&
      child2?.parentID === parent.id &&
      tools2.length > 0 &&
      !entries.some((entry) => entry.type === 'tool:probe_echo') &&
      terminal2,
    cleanReviewEligible: false,
    unknown: parentWait.returned !== true || !child2 || tools2.length === 0,
  };
  await host.client.session.interrupt({ sessionID: parent.id, resume: false }).catch(() => {});
  if (child2ID)
    await host.client.session.interrupt({ sessionID: child2ID, resume: false }).catch(() => {});

  report.observations = {
    simpleChainValid: report.simple.chainValid === true,
    simpleAssuranceValid: report.simple.assuranceValid === true,
    reusedChildLatestWouldBeForged: report.forgedReuse.naiveLatestIsForged === true,
    exactOriginalChainSurvivesReuse: report.forgedReuse.exactChainRemainsOriginal === true,
    toolAttemptWasDeniedBeforeEffect: report.toolAttempt.toolExecuted === false,
    toolAttemptChildTerminalObserved: report.toolAttempt.terminal === true,
    toolAttemptParentCompleted: report.toolAttempt.parentWait.returned === true,
    toolAttemptFlowCompleted: report.toolAttempt.flowCompleted === true,
    toolAttemptCleanReviewEligible: false,
    toolAttemptOutcomeUnknown: report.toolAttempt.unknown === true,
    toolAttemptLoopGuardTriggered: report.toolAttempt.loopGuardTriggered === true,
    fullReviewerAssurance: 'NOT_VERIFIED',
  };
  report.simple = { ...report.simple, child: { id: child.id, parentID: child.parentID } };
  report.toolAttempt = {
    ...report.toolAttempt,
    child: child2 ? { id: child2.id, parentID: child2.parentID } : null,
  };
} catch (error) {
  report.error = { code: error.code, message: String(error), stack: error.stack };
} finally {
  try {
    await host.close();
    report.cleanup = { completed: true };
  } catch (error) {
    report.cleanup = { completed: false, error: String(error) };
  }
}
for (const path of [
  'lib/host.mjs',
  'lib/isolation.mjs',
  'lib/provider.mjs',
  'lib/review-evidence.mjs',
  'lib/scope-evidence.mjs',
  'plugin/flowguard-probe.js',
  'probes/p0-reviewer-provenance.mjs',
]) {
  report.sourceSha256[path] = createHash('sha256')
    .update(await readFile(new URL(`../${path}`, import.meta.url)))
    .digest('hex');
}
await writeFile(join(runDir, 'raw.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ runDir, ...report }, null, 2));
// Exit 0 means observations completed; it is not a reviewer-assurance PASS.
if (report.error || report.cleanup?.completed !== true) process.exitCode = 1;
