#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/length-steps');
await mkdir(outDir, { recursive: true });

function lengthScript(lengthCount) {
  let index = 0;
  return () => {
    const current = index++;
    if (current < lengthCount) return { text: `partial-${current + 1}`, finish: 'length' };
    return { text: 'final-stop', finish: 'stop' };
  };
}

async function runLength(name, lengthCount) {
  const host = await startProbeHost({ name, script: lengthScript(lengthCount) });
  const result = { name, lengthCount, serverInfo: host.serverInfo, passed: false };
  try {
    await host.activate();
    const session = await host.session(name);
    await host.prompt(session.id, 'Produce a long answer.');
    try {
      await host.client.session.wait({ sessionID: session.id });
      result.wait = 'returned';
    } catch (error) {
      result.wait = 'threw';
      result.waitError = String(error);
    }
    const context = await host.client.session.context({ sessionID: session.id });
    result.messages = context.map((message) => ({
      type: message.type,
      id: message.id,
      finish: message.finish,
      outcome: message.outcome,
      error: message.error,
      text: typeof message.text === 'string' ? message.text.slice(0, 100) : undefined,
      content: Array.isArray(message.content)
        ? message.content.map((part) => ({ type: part.type, text: part.text?.slice?.(0, 100) }))
        : undefined,
    }));
    result.requests = host.provider.requests.map((request) => ({
      lastUser: [...(request.body?.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'user')?.content,
      toolChoice: request.body?.tool_choice,
      maxCompletionTokens: request.body?.max_completion_tokens,
    }));
    const synthetic = result.messages.filter((message) => message.type === 'synthetic');
    const assistants = result.messages.filter((message) => message.type === 'assistant');
    const idle = result.messages.find((message) => message.type === 'idle');
    result.observation = {
      syntheticMessages: synthetic.length,
      assistantFinishes: assistants.map((message) => message.finish),
      assistantCount: assistants.length,
      finalAssistantFinish: assistants.at(-1)?.finish,
      idle: result.messages.some((message) => message.type === 'idle'),
      idleOutcome: idle?.outcome,
    };
    result.passed =
      lengthCount === 1
        ? assistants.length >= 2 &&
          assistants[0]?.finish === 'length' &&
          assistants.at(-1)?.finish === 'stop' &&
          synthetic.length >= 1 &&
          idle?.outcome === 'succeeded'
        : assistants.length === 3 &&
          assistants.every((message) => message.finish === 'length') &&
          idle?.outcome !== 'succeeded';
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  return result;
}

function stepScript() {
  return (body) => {
    if (body?.tool_choice === 'none') return { text: 'FINAL_STOP', finish: 'stop' };
    return {
      tool: { name: 'probe_direct', arguments: { text: 'step' } },
      finish: 'tool_calls',
    };
  };
}

async function runSteps() {
  const host = await startProbeHost({ name: 'steps', limitedAgent: true, script: stepScript() });
  const result = { serverInfo: host.serverInfo, passed: false };
  try {
    await host.activate();
    const session = await host.client.session.create({
      title: 'step ceiling',
      agent: 'probe-limited',
      location: { directory: host.project },
    });
    await host.prompt(session.id, 'Call the probe tool.');
    try {
      await host.client.session.wait({ sessionID: session.id });
      result.wait = 'returned';
    } catch (error) {
      result.wait = 'threw';
      result.waitError = String(error);
    }
    const context = await host.client.session.context({ sessionID: session.id });
    const entries = await host.entries();
    const contexts = entries.filter((entry) => entry.type === 'hook:session.context');
    result.messages = context.map((message) => ({
      type: message.type,
      finish: message.finish,
      content: Array.isArray(message.content)
        ? message.content.map((part) => ({
            type: part.type,
            name: part.name,
            state: part.state?.status,
          }))
        : undefined,
    }));
    result.contextToolCounts = contexts.map((entry) => ({
      toolCount: entry.toolNames?.length,
      toolNames: entry.toolNames,
      options: entry.options,
    }));
    result.requests = host.provider.requests.map((request) => ({
      toolChoice: request.body?.tool_choice,
      hasTools: Array.isArray(request.body?.tools) && request.body.tools.length > 0,
      lastUser: [...(request.body?.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'user')?.content,
    }));
    result.observation = {
      assistantCount: result.messages.filter((message) => message.type === 'assistant').length,
      finalAssistant: result.messages.filter((message) => message.type === 'assistant').at(-1),
      finalToolChoiceNone: result.requests.at(-1)?.toolChoice === 'none',
      seenToolChoiceNone: result.requests.some((request) => request.toolChoice === 'none'),
    };
    const finalAssistant = result.messages.filter((message) => message.type === 'assistant').at(-1);
    result.passed =
      result.observation.assistantCount === 2 &&
      result.observation.finalToolChoiceNone &&
      result.observation.seenToolChoiceNone &&
      finalAssistant?.finish === 'stop';
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  return result;
}

const result = {
  at: new Date().toISOString(),
  oneLength: await runLength('length-one', 1),
  threeLength: await runLength('length-three', 3),
  steps: await runSteps(),
};
result.passed = result.oneLength.passed && result.threeLength.passed && result.steps.passed;
result.status = result.passed ? 'SUPPORTED' : 'NOT_VERIFIED';
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
