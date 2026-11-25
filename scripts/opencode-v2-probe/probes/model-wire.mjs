#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ?? join(process.cwd(), 'scripts/opencode-v2-probe/evidence/model-wire');
await mkdir(outDir, { recursive: true });

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function lastUserText(body) {
  const user = [...(body?.messages ?? [])].reverse().find((message) => message.role === 'user');
  if (!user) return '';
  return typeof user.content === 'string' ? user.content : JSON.stringify(user.content);
}

function hasToolResult(body) {
  return Array.isArray(body?.messages) && body.messages.some((message) => message.role === 'tool');
}

function script(body, _index, meta) {
  const sid = header(meta?.headers, 'x-opencode-session-id');
  if (!globalThis.__wireParent) globalThis.__wireParent = sid;
  if (sid === globalThis.__wireParent) {
    if (body?.messages?.at(-1)?.role === 'tool') return { text: 'PARENT_OK', finish: 'stop' };
    return {
      tool: {
        name: 'subagent',
        arguments: {
          agent: 'probe-reviewer',
          description: 'wire reviewer',
          prompt: 'Return CHILD_OK',
        },
      },
      finish: 'tool_calls',
    };
  }
  const last = lastUserText(body);
  if (last.includes('SERIALIZE_WIRE')) return { text: 'SERIALIZED', finish: 'stop' };
  return { text: 'CHILD_OK', finish: 'stop' };
}

async function runChosen() {
  globalThis.__wireParent = undefined;
  const host = await startProbeHost({ name: 'wire-chosen', script });
  const result = { serverInfo: host.serverInfo, requests: {}, passed: false };
  try {
    await host.activate();
    const parent = await host.session('wire chosen parent');
    await host.client.session.switchModel({
      sessionID: parent.id,
      model: { providerID: 'probe', id: 'probe', variant: 'chosen' },
    });
    await host.prompt(parent.id, 'Run reviewer');
    await host.client.session.wait({ sessionID: parent.id });
    const children = (await host.client.session.list({})).data.filter(
      (s) => s.parentID === parent.id,
    );
    const child = children[0];
    if (!child) throw new Error('no reviewer child');
    const followupID = `msg_probe_wire_${Date.now()}`;
    await host.client.session.prompt({
      sessionID: child.id,
      id: followupID,
      text: 'SERIALIZE_WIRE',
      delivery: 'queue',
    });
    await host.client.session.wait({ sessionID: child.id });
    const requests = host.provider.requests.map((request) => ({
      sessionID: header(request.headers, 'x-opencode-session-id'),
      model: request.body?.model,
      reasoningEffort: request.body?.reasoning_effort,
      maxCompletionTokens: request.body?.max_completion_tokens,
      lastUser: lastUserText(request.body).slice(0, 80),
      hasToolResult: hasToolResult(request.body),
    }));
    result.parentID = parent.id;
    result.childID = child.id;
    result.requests = {
      parent: requests.filter((request) => request.sessionID === parent.id),
      reviewer: requests.filter(
        (request) => request.sessionID === child.id && request.lastUser.includes('CHILD_OK'),
      ),
      serialization: requests.filter(
        (request) => request.sessionID === child.id && request.lastUser.includes('SERIALIZE_WIRE'),
      ),
    };
    result.passed =
      result.requests.parent.length > 0 &&
      result.requests.reviewer.length > 0 &&
      result.requests.serialization.length > 0 &&
      [result.requests.parent, result.requests.reviewer, result.requests.serialization].every(
        (group) =>
          group.some(
            (request) =>
              request.model === 'probe' &&
              request.reasoningEffort === 'high' &&
              request.maxCompletionTokens === 8192,
          ),
      );
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runDefault() {
  const host = await startProbeHost({
    name: 'wire-default',
    script: () => ({ text: 'DEFAULT_OK' }),
  });
  const result = { serverInfo: host.serverInfo, requests: [], passed: false };
  try {
    await host.activate();
    const session = await host.session('wire default');
    await host.prompt(session.id, 'Default model request');
    await host.client.session.wait({ sessionID: session.id });
    result.requests = host.provider.requests.map((request) => ({
      model: request.body?.model,
      reasoningEffort: request.body?.reasoning_effort,
      maxCompletionTokens: request.body?.max_completion_tokens,
    }));
    result.passed =
      result.requests.length === 1 &&
      result.requests[0].model === 'probe' &&
      result.requests[0].reasoningEffort === undefined &&
      result.requests[0].maxCompletionTokens === 8192;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  return result;
}

const result = {
  at: new Date().toISOString(),
  chosen: await runChosen(),
  default: await runDefault(),
};
result.passed = result.chosen.passed && result.default.passed;
result.status = result.passed ? 'SUPPORTED' : 'NOT_VERIFIED';
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
