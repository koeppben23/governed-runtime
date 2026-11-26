#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/subagent-contract');
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

let parentID;
let childID;
const script = (body, _index, meta) => {
  const sid = header(meta?.headers, 'x-opencode-session-id');
  if (!parentID) parentID = sid;
  if (sid === parentID) {
    const messages = body?.messages ?? [];
    const lastRole = messages.at(-1)?.role;
    if (lastRole === 'tool') return { text: 'PARENT_OK', finish: 'stop' };
    const text = lastUserText(body);
    if (/Reuse reviewer/i.test(text) && childID) {
      return {
        tool: {
          name: 'subagent',
          arguments: {
            agent: 'probe-reviewer',
            description: 'reuse reviewer',
            prompt: 'REUSE_CHILD',
            sessionID: childID,
          },
        },
        finish: 'tool_calls',
      };
    }
    if (/Model reviewer/i.test(text)) {
      return {
        tool: {
          name: 'subagent',
          arguments: {
            agent: 'probe-reviewer',
            description: 'model reviewer',
            prompt: 'MODEL_CHILD',
            model: 'probe/probe#chosen',
          },
        },
        finish: 'tool_calls',
      };
    }
    if (/Background reviewer/i.test(text)) {
      return {
        tool: {
          name: 'subagent',
          arguments: {
            agent: 'probe-reviewer',
            description: 'background reviewer',
            prompt: 'BACKGROUND_CHILD',
            background: true,
          },
        },
        finish: 'tool_calls',
      };
    }
    return {
      tool: {
        name: 'subagent',
        arguments: {
          agent: 'probe-reviewer',
          description: 'new reviewer',
          prompt: 'CHILD_OK',
        },
      },
      finish: 'tool_calls',
    };
  }
  childID = sid;
  const text = lastUserText(body);
  if (/REUSE_CHILD/.test(text)) return { text: 'CHILD_REUSED', finish: 'stop' };
  if (/MODEL_CHILD/.test(text)) return { text: 'CHILD_MODEL', finish: 'stop' };
  if (/BACKGROUND_CHILD/.test(text)) return { text: 'CHILD_BACKGROUND', finish: 'stop' };
  return { text: 'CHILD_OK', finish: 'stop' };
};

const host = await startProbeHost({ name: 'subagent-contract', script });
const result = {
  at: new Date().toISOString(),
  serverInfo: host.serverInfo,
  cases: {},
  providerRequests: [],
  passed: false,
};
try {
  await host.activate();
  const parent = await host.session('subagent contract parent');
  result.parentID = parent.id;
  await host.prompt(parent.id, 'Create reviewer');
  await host.client.session.wait({ sessionID: parent.id });
  const children = (await host.client.session.list({})).data.filter(
    (s) => s.parentID === parent.id,
  );
  if (children.length === 0) throw new Error('no child created');
  const child = children[0];
  result.childID = child.id;

  // Reuse an existing child by supplying its sessionID.
  await host.prompt(parent.id, 'Reuse reviewer');
  await host.client.session.wait({ sessionID: parent.id });
  const reuseContext = await host.client.session.context({ sessionID: child.id });
  result.cases.sessionIDReuse = {
    hostAccepted: reuseContext.filter((message) => message.type === 'user').length > 1,
    childMessages: reuseContext.map((message) => ({ type: message.type, id: message.id })),
    flowGuardMustReject: true,
  };

  // Caller-supplied model override.
  await host.prompt(parent.id, 'Model reviewer');
  await host.client.session.wait({ sessionID: parent.id });
  const modelRequestRecord = host.provider.requests.find((request) =>
    lastUserText(request.body).includes('MODEL_CHILD'),
  );
  const modelRequest = modelRequestRecord?.body;
  result.cases.modelOverride = {
    hostAccepted: Boolean(modelRequest),
    bodyModel: modelRequest?.model,
    reasoningEffort: modelRequest?.reasoning_effort,
    bodyKeys: modelRequest ? Object.keys(modelRequest).sort() : [],
    flowGuardMustReject: true,
  };

  // Background subagent: the host returns a running handle and continues later.
  await host.prompt(parent.id, 'Background reviewer');
  await host.client.session.wait({ sessionID: parent.id });
  const childrenAfter = (await host.client.session.list({})).data.filter(
    (s) => s.parentID === parent.id,
  );
  const backgroundChild = childrenAfter.find((session) => session.id !== child.id);
  let backgroundStatus;
  if (backgroundChild) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      backgroundStatus = await host.client.session.get({ sessionID: backgroundChild.id });
      if (backgroundStatus.outcome || backgroundStatus.time?.idle) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  result.cases.background = {
    hostAccepted: Boolean(backgroundChild),
    childID: backgroundChild?.id,
    status: backgroundStatus?.outcome ?? null,
    flowGuardMustReject: true,
  };

  result.providerRequests = host.provider.requests.map((request) => ({
    sessionID: header(request.headers, 'x-opencode-session-id'),
    model: request.body?.model,
    reasoningEffort: request.body?.reasoning_effort,
    hasToolResult: hasToolResult(request.body),
    lastUser: lastUserText(request.body).slice(0, 160),
  }));
  result.passed =
    result.cases.sessionIDReuse.hostAccepted &&
    result.cases.modelOverride.hostAccepted &&
    result.cases.background.hostAccepted;
} catch (error) {
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await host.close();
if (!result.passed) process.exitCode = 1;
