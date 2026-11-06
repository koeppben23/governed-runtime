#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/reviewer-lineage');
await mkdir(outDir, { recursive: true });

function sessionID(headers) {
  const value = headers?.['x-opencode-session-id'];
  return Array.isArray(value) ? value[0] : value;
}

function hasToolResult(body) {
  return Array.isArray(body?.messages) && body.messages.some((message) => message.role === 'tool');
}

function lineageScript(body, _index, meta) {
  const id = sessionID(meta?.headers);
  if (!id) return { text: 'unknown-session' };
  if (globalThis.__probeParent === undefined) globalThis.__probeParent = id;
  if (id === globalThis.__probeParent) {
    if (hasToolResult(body)) return { text: 'PARENT_OK', finish: 'stop' };
    return {
      tool: {
        name: 'subagent',
        arguments: {
          agent: 'probe-reviewer',
          description: 'probe review',
          prompt: 'Return CHILD_OK',
        },
      },
      finish: 'tool_calls',
    };
  }
  if (hasToolResult(body)) return { text: 'CHILD_FOLLOWUP_OK', finish: 'stop' };
  const lastUser = [...(body?.messages ?? [])].reverse().find((message) => message.role === 'user');
  const lastText =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : JSON.stringify(lastUser?.content ?? '');
  if (lastText.includes('GENERATE_PROBE')) return { text: 'GENERATE_OK', finish: 'stop' };
  if (lastText.includes('Serialize CHILD_OK')) return { text: 'CHILD_SERIALIZED', finish: 'stop' };
  return { text: 'CHILD_OK', finish: 'stop' };
}

globalThis.__probeParent = undefined;
const host = await startProbeHost({ name: 'lineage', script: lineageScript });
const result = {
  at: new Date().toISOString(),
  serverInfo: host.serverInfo,
  parent: null,
  child: null,
  followup: null,
  generate: null,
  events: [],
  assistantFields: [],
  passed: false,
};
try {
  await host.activate();
  const parent = await host.session('lineage parent');
  result.parent = { id: parent.id };
  const admission = await host.prompt(parent.id, 'Run the probe reviewer.');
  result.parent.admission = admission;
  try {
    await host.client.session.wait({ sessionID: parent.id });
  } catch (error) {
    result.parent.waitError = String(error);
  }
  const sessions = await host.client.session.list({});
  result.parent.context = (await host.client.session.context({ sessionID: parent.id })).map(
    (message) => ({
      type: message.type,
      id: message.id,
      finish: message.finish,
      content: Array.isArray(message.content)
        ? message.content.map((part) => ({
            type: part.type,
            name: part.name,
            state: part.state?.status,
          }))
        : undefined,
    }),
  );
  result.parent.children = sessions.data
    .filter((session) => session.parentID === parent.id)
    .map((session) => ({
      id: session.id,
      parentID: session.parentID,
      agent: session.agent,
      model: session.model,
    }));

  const childInfo = result.parent.children[0];
  if (!childInfo) throw new Error('subagent did not create a visible child');
  result.child = {
    id: childInfo.id,
    info: await host.client.session.get({ sessionID: childInfo.id }),
    context: (await host.client.session.context({ sessionID: childInfo.id })).map((message) => ({
      type: message.type,
      id: message.id,
      keys: Object.keys(message),
      parentIDPresent: Object.prototype.hasOwnProperty.call(message, 'parentID'),
      parentID: message.parentID,
      finish: message.finish,
      agent: message.agent,
      model: message.model,
    })),
  };

  const followupID = `msg_probe_followup_${Date.now()}`;
  const follow = await host.client.session.prompt({
    sessionID: childInfo.id,
    id: followupID,
    text: 'Serialize CHILD_OK',
    delivery: 'queue',
  });
  try {
    await host.client.session.wait({ sessionID: childInfo.id });
  } catch (error) {
    result.followup = { waitError: String(error) };
  }
  const followContext = await host.client.session.context({ sessionID: childInfo.id });
  result.followup = {
    admissionID: follow.id,
    requestedID: followupID,
    messages: followContext.map((message) => ({
      type: message.type,
      id: message.id,
      keys: Object.keys(message),
      parentIDPresent: Object.prototype.hasOwnProperty.call(message, 'parentID'),
      parentID: message.parentID,
      finish: message.finish,
      agent: message.agent,
      model: message.model,
    })),
  };

  const beforeGenerate = followContext.length;
  const generated = await host.client.session.generate({
    sessionID: childInfo.id,
    prompt: 'GENERATE_PROBE',
  });
  const afterGenerate = await host.client.session.context({ sessionID: childInfo.id });
  result.generate = {
    text: generated.text,
    beforeMessages: beforeGenerate,
    afterMessages: afterGenerate.length,
    messagesAdded: afterGenerate.length - beforeGenerate,
  };

  const allMessages = [
    ...result.child.context,
    ...result.followup.messages,
    ...afterGenerate.map((message) => ({
      type: message.type,
      id: message.id,
      parentID: message.parentID,
      finish: message.finish,
      agent: message.agent,
      model: message.model,
    })),
  ];
  result.assistantFields = allMessages.filter((message) => message.type === 'assistant');
  result.events = (await host.entries())
    .filter((entry) => entry.type === 'event')
    .map((entry) => ({ type: entry.eventType, data: entry.data }));
  const hasChildParent = result.child.info.parentID === parent.id;
  const user = result.followup.messages.find(
    (message) => message.type === 'user' && message.id === followupID,
  );
  const assistant = result.followup.messages.find((message) => message.type === 'assistant');
  const idle = result.followup.messages.find((message) => message.type === 'idle');
  result.passed =
    hasChildParent &&
    Boolean(user) &&
    Boolean(assistant) &&
    Boolean(idle) &&
    assistant?.parentIDPresent === false &&
    result.generate.messagesAdded === 0;
} catch (error) {
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await host.close();
if (!result.passed) process.exitCode = 1;
