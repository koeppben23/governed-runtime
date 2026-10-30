/**
 * Installed-artifact OpenCode v2 probe plugin.
 *
 * Uses the supported `Plugin.define` entrypoint from the pinned
 * `@opencode/plugin@2.2.4` package. FlowGuard production code is not imported
 * here; the host loads this file from a disposable project and the probe must
 * prove what that exact installed entrypoint can observe.
 */
import { appendFileSync } from 'node:fs';
import { Model, Plugin, Provider } from '@opencode/plugin';

const JOURNAL = process.env.FG_PROBE_JOURNAL ?? '';
const DENY_TOOLS = new Set(
  (process.env.FG_PROBE_DENY_TOOLS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const MAX_TEXT = 200_000;

function record(type, data = {}) {
  if (!JOURNAL) return;
  try {
    appendFileSync(
      JOURNAL,
      `${JSON.stringify({
        at: new Date().toISOString(),
        type,
        ...data,
      })}\n`,
    );
  } catch {
    // The probe must not alter host behavior when its journal is unavailable.
  }
}

function limit(value) {
  if (typeof value !== 'string') return value;
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}…[truncated]`;
}

function eventSummary(event) {
  const data = event?.data ?? {};
  const summary = { eventType: event?.type, eventID: event?.id, data: {} };
  for (const key of [
    'sessionID',
    'parentID',
    'inboxID',
    'assistantMessageID',
    'messageID',
    'agent',
    'model',
    'kind',
    'status',
    'finish',
    'reason',
    'executed',
    'id',
  ]) {
    if (key in data) summary.data[key] = data[key];
  }
  if (event?.type === 'session.tool.called' || event?.type === 'session.tool.success') {
    summary.data.tool = data.tool;
  }
  if (data.info && typeof data.info === 'object') {
    summary.data.info = {
      id: data.info.id,
      parentID: data.info.parentID,
      agent: data.info.agent,
      model: data.info.model,
    };
  }
  if (event?.type === 'session.created' && data.session && typeof data.session === 'object') {
    summary.data.session = {
      id: data.session.id,
      parentID: data.session.parentID,
      agent: data.session.agent,
      model: data.session.model,
    };
  }
  return summary;
}

async function requestText(request) {
  try {
    return limit(await request.clone().text());
  } catch {
    return '[unreadable request body]';
  }
}

export default Plugin.define({
  id: 'flowguard.host-probe',
  async setup(ctx) {
    const controller = new AbortController();
    if (process.env.FG_PROBE_FAIL_SETUP === '1') {
      record('setup:fail', { pid: process.pid });
      throw new Error('FG_PROBE_FAIL_SETUP');
    }
    record('setup:start', {
      appVersion: ctx.app?.version,
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv,
      location: ctx.location,
      journal: JOURNAL,
      denyTools: [...DENY_TOOLS],
    });

    if (process.env.FG_PROBE_REGISTER_PROVIDER === '1') {
      const providerID = Provider.ID.make('probe');
      const modelID = Model.ID.make('probe');
      const baseURL = process.env.FG_PROBE_PROVIDER_URL ?? '';
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: 'FlowGuard Probe',
            activation: 'enabled',
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL, apiKey: 'probe-only' },
          },
          models: [
            {
              ...Model.Info.default(providerID, modelID),
              name: 'Probe',
              limit: { context: 128_000, output: 8_192 },
              capabilities: { tools: true },
            },
          ],
        });
      });
      record('setup:provider-registered', { providerID: 'probe', modelID: 'probe', baseURL });
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'probe_echo',
        description: 'Return the probe input unchanged.',
        input: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        async execute(input) {
          const text = String(input?.text ?? '');
          record('tool:probe_echo', { text });
          return { content: text };
        },
      });
      editor.add({
        name: 'probe_direct',
        description: 'Directly callable probe tool.',
        options: { codemode: false },
        input: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        async execute(input) {
          const text = String(input?.text ?? '');
          record('tool:probe_direct', { text });
          return { content: text };
        },
      });
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: 'probe-plugin-command',
        description: 'Probe command registered by the plugin.',
        async execute(input) {
          record('command:probe-plugin-command', {
            sessionID: input.sessionID,
            prompt: limit(input.prompt?.text),
            delivery: input.delivery,
          });
          await ctx.session.prompt({
            ...input.prompt,
            sessionID: input.sessionID,
            text: `plugin-command:${input.prompt?.text ?? ''}`,
            delivery: input.delivery,
          });
        },
      });
    });

    await ctx.tool.hook('execute.before', (event) => {
      record('hook:tool.execute.before', {
        tool: event.tool,
        sessionID: event.sessionID,
        agent: event.agent,
        messageID: event.messageID,
        id: event.id,
        input: limit(JSON.stringify(event.input ?? null)),
      });
      if (DENY_TOOLS.has(event.tool)) {
        throw new Error(
          JSON.stringify({
            code: 'FG_PROBE_DENIED',
            tool: event.tool,
            reason: 'installed probe denied this tool before execution',
          }),
        );
      }
    });

    await ctx.tool.hook('execute.after', (event) => {
      const outcome =
        event.status === 'completed'
          ? { result: limit(JSON.stringify(event.result ?? null)) }
          : { error: limit(JSON.stringify(event.error ?? null)) };
      record('hook:tool.execute.after', {
        tool: event.tool,
        sessionID: event.sessionID,
        agent: event.agent,
        messageID: event.messageID,
        id: event.id,
        status: event.status,
        ...outcome,
      });
    });

    await ctx.session.hook('prompt', (event) => {
      record('hook:session.prompt', {
        sessionID: event.sessionID,
        messageID: event.messageID,
        prompt: limit(event.prompt?.text),
        metadata: event.metadata,
        delivery: event.delivery,
      });
    });

    await ctx.session.hook('context', (event) => {
      record('hook:session.context', {
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        options: event.options,
        toolNames: Object.keys(event.tools ?? {}).sort(),
        system: Array.isArray(event.system)
          ? event.system.map((part) => ({
              type: part?.type,
              instructionKeys: part?.metadata?.experimental?.instructions?.map(
                (instruction) => instruction?.key,
              ),
              instructions: part?.metadata?.experimental?.instructions?.map((instruction) => ({
                key: instruction?.key,
                text:
                  typeof instruction?.text === 'string'
                    ? instruction.text.length > 2_000
                      ? `${instruction.text.slice(0, 2_000)}…[truncated]`
                      : instruction.text
                    : undefined,
              })),
              text:
                typeof part?.text === 'string'
                  ? part.text.length > 500
                    ? `${part.text.slice(0, 500)}…[truncated]`
                    : part.text
                  : undefined,
            }))
          : undefined,
      });
    });

    await ctx.session.hook('model.request', (event) => {
      record('hook:session.model.request', {
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        kind: event.kind,
        baseURL: event.baseURL,
        headers: Object.fromEntries(
          Object.entries(event.headers ?? {}).filter(
            ([key]) => key.toLowerCase() !== 'authorization',
          ),
        ),
      });
    });

    await ctx.session.hook('http.request', async (event) => {
      const bodyText = await event.request.clone().text();
      if (process.env.FG_PROBE_FAIL_RELOAD_BEFORE_SEND === '1') {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(
          new URL(import.meta.url),
          "export default { id: 'flowguard.host-probe', async setup() { throw new Error('toctou-reload-fail') } }\n",
          'utf8',
        );
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        record('hook:session.http.request:self-fail-returned', {
          sessionID: event.sessionID,
        });
      }
      let hostedTool = false;
      if (process.env.FG_PROBE_DENY_HOSTED_TOOLS === '1') {
        try {
          const parsed = JSON.parse(bodyText);
          hostedTool = (parsed?.tools ?? []).some((tool) => {
            const type = String(tool?.type ?? '');
            return [
              'web_search',
              'web_search_preview',
              'web_extractor',
              'code_interpreter',
              'image_generation',
              'file_search',
            ].some((name) => type.includes(name));
          });
        } catch {
          /* let the host report malformed provider payloads */
        }
      }
      if (hostedTool) {
        record('hook:session.http.request:denied-hosted-tool', {
          sessionID: event.sessionID,
          body: limit(bodyText),
        });
        throw new Error(
          JSON.stringify({
            code: 'FG_PROBE_HOSTED_TOOL_DENIED',
            reason: 'hosted tool definition in final provider request',
          }),
        );
      }
      record('hook:session.http.request', {
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        kind: event.kind,
        method: event.request?.method,
        url: event.request?.url,
        headers: Object.fromEntries(
          [...(event.request?.headers?.entries?.() ?? [])].filter(
            ([key]) => key.toLowerCase() !== 'authorization',
          ),
        ),
        body: limit(bodyText),
      });
    });

    await ctx.session.hook('http.response', async (event) => {
      let body = '[unreadable response body]';
      try {
        body = limit(await event.response.clone().text());
      } catch {
        /* keep sentinel */
      }
      record('hook:session.http.response', {
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        kind: event.kind,
        status: event.response?.status,
        body,
      });
    });

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
          types: [
            'session.created',
            'session.deleted',
            'session.idle',
            'session.execution.started',
            'session.execution.succeeded',
            'session.execution.failed',
            'session.execution.interrupted',
            'session.inbox.enqueued',
            'session.inbox.delivered',
            'session.inbox.cancelled',
            'session.step.started',
            'session.step.ended',
            'session.step.failed',
            'session.tool.called',
            'session.tool.success',
            'session.tool.failed',
            'session.message.content.updated',
          ],
        })) {
          record('event', eventSummary(event));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          record('event:error', { error: String(error) });
        }
      }
    })();

    try {
      const plugins = await ctx.plugin.list();
      record('setup:plugin-list', { plugins });
    } catch (error) {
      record('setup:plugin-list:error', { error: String(error) });
    }
    try {
      const tools = await ctx.tool.list();
      record('setup:tool-list', { tools: tools.map((tool) => tool.id).sort() });
    } catch (error) {
      record('setup:tool-list:error', { error: String(error) });
    }
    try {
      const commands = await ctx.command.list();
      const commandList = Array.isArray(commands) ? commands : commands?.data;
      record('setup:command-list', {
        shape: Array.isArray(commands) ? 'array' : 'object',
        commands: Array.isArray(commandList)
          ? commandList.map((command) => command?.name ?? command?.id).sort()
          : commandList,
      });
    } catch (error) {
      record('setup:command-list:error', { error: String(error) });
    }

    record('setup:ready', {
      appVersion: ctx.app?.version,
      pid: process.pid,
      location: ctx.location,
    });

    return () => {
      controller.abort();
      record('cleanup', { pid: process.pid });
    };
  },
});
