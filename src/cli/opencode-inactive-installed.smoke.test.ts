/** P0-00: real packed installs. No seeded authority; mixed tests use native Start. */
import { existsSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionMessageAssistantTool } from '@opencode/client';
import { TOOL_FLOWGUARD_HELP } from '../integration/tool-names.js';
import { PLUGIN_RELATIVE_PATH, PLUGIN_WRAPPER } from './templates.js';
import { createNativeHostProbe, type NativeProbeReply } from './opencode-native-test-helpers.js';
import { createPackedFlowGuardInstall } from './opencode-packed-install-test-helpers.js';
import { FLOWGUARD_TOOL_NAMES } from '../integration/tool-names.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { renderPhaseAwareMandates } from '../rendering/mandates-renderer.js';
import { withTestEnv } from '../integration/test-helpers.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let artifact: Awaited<ReturnType<typeof createPackedFlowGuardInstall>>;

async function arm(
  installed: boolean,
  git: boolean,
  scope: 'repo' | 'global',
  catalogue: 'bundled' | 'live' = 'bundled',
) {
  const scripts = new Map<string, NativeProbeReply[]>();
  let customerConfig = '';
  let providerURL = '';
  let childReply: NativeProbeReply | undefined;
  const probe = await createNativeHostProbe({
    git,
    async prepare(project, env) {
      // Both arms use the host's complete bundled catalogue. The pinned host
      // otherwise refreshes models.dev asynchronously during bootstrap, making
      // independent hosts compare bundled versus live data rather than plugins.
      // This freezes an external input; it does not filter any model/provider.
      if (catalogue === 'bundled') env.OPENCODE_DISABLE_MODELS_FETCH = '1';
      else delete env.OPENCODE_DISABLE_MODELS_FETCH;
      const configPath = join(project, 'opencode.json');
      await writeFile(
        join(project, '.gitignore'),
        '.opencode/node_modules/\n.opencode/vendor/\nobserver.jsonl\n',
      );
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.instructions = ['CUSTOM.md'];
      providerURL = config.providers.capture.settings.baseURL;
      config.providers.capture.models.probe.variants.push({
        id: 'quiet',
        settings: { reasoningEffort: 'low' },
      });
      await writeFile(
        join(project, 'CUSTOM.md'),
        'P0-00 customer instructions must remain native.\n',
      );
      await writeFile(join(project, 'AGENTS.md'), 'P0-00 root agent instructions remain native.\n');
      customerConfig = JSON.stringify(config, null, 2) + '\n';
      await writeFile(configPath, customerConfig);
      if (installed) {
        expect(await artifact.install(project, env, scope)).not.toContain('[error]');
        const target = scope === 'repo' ? join(project, '.opencode') : env.OPENCODE_CONFIG_DIR!;
        expect(await readFile(join(target, PLUGIN_RELATIVE_PATH), 'utf8')).toBe(PLUGIN_WRAPPER);
      }
    },
    script(_body, sessionID) {
      if (!scripts.has(sessionID) && childReply) {
        scripts.set(sessionID, [childReply]);
      }
      return scripts.get(sessionID)?.shift() ?? { text: 'Native operation completed.' };
    },
  });
  try {
    const plugins = await probe.client.plugin.list({ location: probe.location });
    const product = plugins.data.filter((plugin) => plugin.id === 'flowguard');
    expect(product).toHaveLength(installed ? 1 : 0);
    if (installed) expect(product[0]!.state).toEqual({ status: 'active' });
  } catch (error) {
    await probe.close();
    throw error;
  }
  return {
    ...probe,
    // Keep the live client accessor for restart comparisons.
    get client() {
      return probe.client;
    },
    scripts,
    canonicalRoot: await realpath(probe.root),
    providerURL,
    child(reply: NativeProbeReply | undefined) {
      childReply = reply;
    },
    async unchanged() {
      expect(await readFile(join(probe.project, 'opencode.json'), 'utf8')).toBe(customerConfig);
      expect(await readFile(join(probe.project, 'AGENTS.md'), 'utf8')).toBe(
        'P0-00 root agent instructions remain native.\n',
      );
      expect(existsSync(join(probe.env.OPENCODE_CONFIG_DIR!, 'workspaces'))).toBe(false);
      expect(probe.errors).toEqual([]);
    },
  };
}

type Arm = Awaited<ReturnType<typeof arm>>;

/** Only the known fixture roots and configured loopback URL differ between arms.
 * No timestamps, native definitions, instructions or result content are dropped. */
function fixturePaths(value: unknown, probe: Arm): unknown {
  let serialized = JSON.stringify(value);
  // Native shell commands use forward slashes on Windows; probe roots use
  // backslashes. Normalize both spellings before comparing arms.
  for (const root of [probe.canonicalRoot, probe.root]) {
    for (const variant of new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')])) {
      serialized = serialized
        .replaceAll(JSON.stringify(variant).slice(1, -1), '<fixture-root>')
        .replaceAll(variant, '<fixture-root>');
    }
  }
  return JSON.parse(
    serialized.replaceAll(JSON.stringify(probe.providerURL).slice(1, -1), '<fixture-provider>'),
  );
}

/** Native shell effect valid in PowerShell and POSIX sh: one outer
 * double-quoted `-e` script, single-quoted JS strings, forward-slash paths. */
function nativeWriteCommand(target: string, effect: string) {
  const path = target.replaceAll('\\', '/').replaceAll("'", "\\'");
  return `node -e "require('node:fs').writeFileSync('${path}', '${effect}')"`;
}

function shellEffect(target: string): NativeProbeReply {
  return {
    tool: {
      name: 'shell',
      arguments: {
        command: nativeWriteCommand(target, 'native-effect'),
        description: 'P0-00 native effect',
      },
    },
  };
}

function nativeTools(body: Record<string, unknown>) {
  return (body.tools as Array<{ function: { name: string } }>).filter(
    (tool) => tool.function.name !== TOOL_FLOWGUARD_HELP,
  );
}

function nativeRequest(body: Record<string, unknown>, probe: Arm) {
  return fixturePaths(
    { ...body, ...(Array.isArray(body.tools) ? { tools: nativeTools(body) } : {}) },
    probe,
  );
}

function systemMessages(body: Record<string, unknown>) {
  return (body.messages as Array<{ role: string; content: string }>).filter(
    (message) => message.role === 'system',
  );
}

async function terminalTools(probe: Arm, sessionID: string, name: string) {
  return (await probe.client.session.context({ sessionID }))
    .flatMap((message) => (message.type === 'assistant' ? message.content : []))
    .filter(
      (part): part is SessionMessageAssistantTool => part.type === 'tool' && part.name === name,
    );
}

describe.skipIf(!LIVE)('packed installed INACTIVE native parity', () => {
  beforeAll(async () => {
    artifact = await createPackedFlowGuardInstall();
  }, 300_000);
  afterAll(async () => {
    await artifact?.close();
  }, 60_000);

  describe.each(['repo', 'global'] as const)(
    'keeps ACTIVE A and INACTIVE B scoped during live catalogue publication and reload, scope=%s',
    (scope) => {
      // Installation is setup, not test work: it can exceed the 300s test cap on Windows.
      const mixedProbe: { current?: Arm } = {};
      beforeAll(async () => {
        mixedProbe.current = await arm(true, true, scope, 'live');
      }, 600_000);
      afterAll(async () => {
        if (mixedProbe.current) await mixedProbe.current.close();
      }, 60_000);
      it('keeps ACTIVE A and INACTIVE B scoped during live catalogue publication and reload', async () => {
        const probe = mixedProbe.current;
        if (!probe) throw new Error('Mixed-session probe was not initialized');
        const began = performance.now();
        const checkpoint = (stage: string) =>
          console.info('inactive-parity-mixed', {
            scope,
            stage,
            elapsedMs: Math.round(performance.now() - began),
          });
        const restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR! });
        try {
          expect(probe.env.OPENCODE_DISABLE_MODELS_FETCH).toBeUndefined();
          const active = await probe.session();
          const inactive = await probe.session();
          const requestBodies = (sessionID: string, start = 0) =>
            probe.requests
              .slice(start)
              .filter((request) => request.sessionID === sessionID)
              .map((request) => request.body);
          await probe.prompt(inactive.id, 'Native baseline.');
          const baseline = requestBodies(inactive.id)[0]!;
          const inactiveView = (body: Record<string, unknown>) => {
            // Compare complete tool definitions, including the permitted help tool.
            expect(body.tools).toEqual(baseline.tools);
            expect(systemMessages(body)).toEqual(systemMessages(baseline));
            expect(JSON.stringify(body.messages)).not.toContain('FlowGuard governance is ACTIVE');
            expect(body.reasoning_effort).toBe('high');
          };
          const beforeStart = probe.requests.length;
          await Promise.all([
            probe.client.session.command({ sessionID: active.id, name: 'start', text: '' }),
            probe.prompt(inactive.id, 'Native request concurrent with Start.'),
          ]);
          await probe.client.session.wait(
            { sessionID: active.id },
            { signal: AbortSignal.timeout(120_000) },
          );
          checkpoint('native-start-completed');
          expect(requestBodies(active.id, beforeStart), probe.output()).toHaveLength(0);
          expect(requestBodies(inactive.id, beforeStart)).toHaveLength(1);
          for (const body of requestBodies(inactive.id, beforeStart)) inactiveView(body);

          const authority = await resolveSessionAuthority({
            root: await realpath(probe.project),
            sessionId: active.id,
          });
          expect(authority.status, probe.output()).toBe('resolved');
          if (authority.status !== 'resolved')
            throw new Error('Native Start did not create its workflow');
          const activation = (await readAuditTrail(authority.sessDir)).filter(
            (event) => event.event === 'governance:activated',
          );
          expect(activation).toHaveLength(1);
          expect(activation[0]!.detail).toMatchObject({
            channel: 'host_command',
            rootSessionId: active.id,
          });
          const mandates = renderPhaseAwareMandates({}, authority.state.phase);
          for (const refresh of ['publication', 'location-reload', 'host-restart'] as const) {
            if (refresh === 'location-reload') await probe.client.location.reload();
            if (refresh === 'host-restart') await probe.restart();
            const start = probe.requests.length;
            await Promise.all([
              probe.prompt(active.id, 'Observe the active catalogue.'),
              probe.prompt(inactive.id, 'Observe the native catalogue.'),
            ]);
            const activeRequests = requestBodies(active.id, start);
            const inactiveRequests = requestBodies(inactive.id, start);
            expect(activeRequests, `${refresh}\n${probe.output()}`).toHaveLength(1);
            expect(inactiveRequests).toHaveLength(1);
            const names = (activeRequests[0]!.tools as Array<{ function: { name: string } }>).map(
              (tool) => tool.function.name,
            );
            expect(names.filter((name) => name.startsWith('flowguard_')).sort()).toEqual(
              [...FLOWGUARD_TOOL_NAMES].sort(),
            );
            expect(
              systemMessages(activeRequests[0]!).some((message) =>
                message.content.includes(mandates),
              ),
            ).toBe(true);
            expect(activeRequests[0]!.reasoning_effort).toBe('high');
            inactiveView(inactiveRequests[0]!);
            checkpoint(refresh);
          }

          const target = join(probe.project, 'inactive-next-to-active.txt');
          await writeFile(target, 'original');
          probe.scripts.set(inactive.id, [shellEffect(target)]);
          const start = probe.requests.length;
          await probe.prompt(inactive.id, 'Perform the native operation.');
          expect(await readFile(target, 'utf8'), probe.output()).toBe('native-effect');
          expect(
            (await terminalTools(probe, inactive.id, 'shell')).map((part) => part.state.status),
          ).toEqual(['completed']);
          for (const body of requestBodies(inactive.id, start)) inactiveView(body);
          await probe.client.session.generate({
            sessionID: inactive.id,
            prompt: 'Generate without governance.',
          });
          await probe.client.session.compact({ sessionID: inactive.id });
          await probe.client.session.wait(
            { sessionID: inactive.id },
            { signal: AbortSignal.timeout(60_000) },
          );
          for (const body of requestBodies(inactive.id, start)) {
            const names = (body.tools ?? []) as Array<{ function: { name: string } }>;
            expect(
              names.filter(
                (tool) =>
                  tool.function.name.startsWith('flowguard_') &&
                  tool.function.name !== TOOL_FLOWGUARD_HELP,
              ),
            ).toEqual([]);
            expect(JSON.stringify(body.messages)).not.toContain(
              JSON.stringify(mandates).slice(1, -1),
            );
          }
          expect(
            (
              await resolveSessionAuthority({
                root: await realpath(probe.project),
                sessionId: inactive.id,
              })
            ).status,
          ).toBe('absent');
          expect(
            (await readAuditTrail(authority.sessDir)).filter(
              (event) => event.event === 'governance:activated',
            ),
          ).toEqual(activation);
          expect(probe.errors).toEqual([]);
          checkpoint('inactive-effects-and-auxiliary-contexts-completed');
        } finally {
          restore();
        }
      }, 300_000);
    },
  );

  describe.each([
    { git: true, scope: 'repo' },
    { git: false, scope: 'repo' },
    { git: true, scope: 'global' },
    { git: false, scope: 'global' },
  ] as const)('Git=$git, scope=$scope', ({ git, scope }) => {
    const arms: Arm[] = [];
    beforeAll(async () => {
      arms.push(await arm(false, git, scope));
      arms.push(await arm(true, git, scope));
    }, 600_000);
    afterAll(async () => {
      await Promise.allSettled(arms.splice(0).map((probe) => probe.close()));
    }, 60_000);

    it('preserves native tool definitions, model choices and the actual provider context', async () => {
      const results = [];
      for (const probe of arms) {
        const session = await probe.session();
        await probe.prompt(session.id, 'Reply without tools.');
        const requests = probe.requests.filter((request) => request.sessionID === session.id);
        expect(requests).toHaveLength(1);
        const body = requests[0]!.body;
        expect(body.reasoning_effort).toBe('high');
        expect(JSON.stringify(body.messages)).toContain(
          'P0-00 customer instructions must remain native.',
        );
        expect(JSON.stringify(body.messages)).toContain(
          'P0-00 root agent instructions remain native.',
        );
        const models = await probe.client.model.list({ location: probe.location });
        results.push({
          wire: nativeRequest(body, probe),
          models: fixturePaths(
            models.data.filter((model) => model.providerID === 'capture'),
            probe,
          ),
          catalogue: models.data.map(({ providerID, id, variants }) => ({
            providerID,
            id,
            variants,
          })),
        });
        await probe.unchanged();
      }
      expect(results[1]).toEqual(results[0]);
    }, 180_000);

    it.each([undefined, 'chosen', 'quiet'])(
      'preserves native model effort selection %s',
      async (variant) => {
        const results = [];
        for (const probe of arms) {
          const session = await probe.client.session.create({
            location: probe.location,
            agent: 'build',
            model: { providerID: 'capture', id: 'probe', ...(variant ? { variant } : {}) },
          });
          await probe.prompt(session.id, 'Reply without tools.');
          const body = probe.requests.filter((request) => request.sessionID === session.id)[0]!
            .body;
          results.push({
            model: body.model,
            effort: body.reasoning_effort,
            maxTokens: body.max_tokens,
          });
          if (variant) expect(body.reasoning_effort).toBe(variant === 'chosen' ? 'high' : 'low');
          await probe.unchanged();
        }
        expect(results[1]).toEqual(results[0]);
      },
      180_000,
    );

    it.each(['shell', 'edit'] as const)(
      'preserves the real native %s effect and completion',
      async (tool) => {
        for (const probe of arms) {
          const target = join(probe.project, `native-${tool}.txt`);
          await writeFile(target, 'original');
          const session = await probe.session();
          probe.scripts.set(session.id, [
            {
              tool: {
                name: tool,
                arguments:
                  tool === 'edit'
                    ? { path: target, oldString: 'original', newString: 'native-effect' }
                    : {
                        command: nativeWriteCommand(target, 'native-effect'),
                        description: 'P0-00 native effect',
                      },
              },
            },
          ]);
          await probe.prompt(session.id);
          expect(await readFile(target, 'utf8'), probe.output()).toBe('native-effect');
          expect(
            (await terminalTools(probe, session.id, tool)).map((part) => part.state.status),
          ).toEqual(['completed']);
          await probe.unchanged();
        }
      },
      180_000,
    );

    it('preserves native subagent execution, child effects and child context', async () => {
      const contexts = [];
      for (const probe of arms) {
        const target = join(probe.project, 'native-child.txt');
        await writeFile(target, 'original');
        const session = await probe.session();
        probe.scripts.set(session.id, [
          {
            tool: {
              name: 'subagent',
              arguments: {
                agent: 'general',
                description: 'P0-00 native child',
                prompt: 'Perform the native operation.',
              },
            },
          },
        ]);
        probe.child(shellEffect(target));
        const start = probe.requests.length;
        try {
          await probe.prompt(session.id);
        } finally {
          probe.child(undefined);
        }
        expect(await readFile(target, 'utf8'), probe.output()).toBe('native-effect');
        expect(
          (await terminalTools(probe, session.id, 'subagent')).map((part) => part.state.status),
        ).toEqual(['completed']);
        const requests = probe.requests
          .slice(start)
          .filter((request) => request.sessionID !== session.id);
        expect(requests).toHaveLength(2);
        contexts.push(
          fixturePaths(
            { messages: requests[0]!.body.messages, tools: nativeTools(requests[0]!.body) },
            probe,
          ),
        );
        await probe.unchanged();
      }
      expect(contexts[1]).toEqual(contexts[0]);
    }, 180_000);

    it('preserves native permission denial before the side effect', async () => {
      const errors = [];
      for (const probe of arms) {
        const target = join(probe.project, 'native-denied.txt');
        await writeFile(target, 'original');
        const session = await probe.session();
        const permissions = [{ action: 'shell', resource: '*', effect: 'deny' as const }];
        await probe.client.session.update({ sessionID: session.id, permissions });
        probe.scripts.set(session.id, [shellEffect(target)]);
        await probe.prompt(session.id);
        expect(await readFile(target, 'utf8')).toBe('original');
        const tools = await terminalTools(probe, session.id, 'shell');
        expect(tools.map((part) => part.state.status)).toEqual(['error']);
        errors.push(
          fixturePaths(
            tools.map((part) => part.state),
            probe,
          ),
        );
        expect((await probe.client.session.get({ sessionID: session.id })).permissions).toEqual(
          permissions,
        );
        await probe.unchanged();
      }
      expect(errors[1]).toEqual(errors[0]);
    }, 180_000);

    it('preserves the native permission ask and executes only after its reply', async () => {
      const requests = [];
      for (const probe of arms) {
        const target = join(probe.project, 'native-ask.txt');
        await writeFile(target, 'original');
        const session = await probe.session();
        await probe.client.session.update({
          sessionID: session.id,
          permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
        });
        probe.scripts.set(session.id, [shellEffect(target)]);
        const controller = new AbortController();
        const pending = (async () => {
          for await (const event of probe.client.event.subscribe({
            types: ['permission.asked'],
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
          })) {
            if (event.type === 'permission.asked' && event.data.sessionID === session.id)
              return event.data;
          }
          throw new Error('No native permission request observed');
        })();
        try {
          await probe.client.session.prompt({
            sessionID: session.id,
            text: 'Perform the native operation.',
          });
          const permission = await pending;
          expect(await readFile(target, 'utf8')).toBe('original');
          expect(await probe.client.permission.list({ sessionID: session.id })).toHaveLength(1);
          requests.push(
            fixturePaths(
              { action: permission.action, resources: permission.resources, save: permission.save },
              probe,
            ),
          );
          await probe.client.permission.reply({
            sessionID: session.id,
            requestID: permission.id,
            decision: 'once',
          });
          await probe.client.session.wait(
            { sessionID: session.id },
            { signal: AbortSignal.timeout(60_000) },
          );
          expect(await readFile(target, 'utf8'), probe.output()).toBe('native-effect');
          expect(
            (await terminalTools(probe, session.id, 'shell')).map((part) => part.state.status),
          ).toEqual(['completed']);
          await probe.unchanged();
        } finally {
          controller.abort();
          await Promise.allSettled([pending]);
        }
      }
      expect(requests[1]).toEqual(requests[0]);
    }, 180_000);

    it('preserves compaction and transient generation context', async () => {
      const results = [];
      for (const probe of arms) {
        const session = await probe.session();
        await probe.prompt(session.id, 'Reply without tools.');
        const start = probe.requests.length;
        await probe.client.session.generate({
          sessionID: session.id,
          prompt: 'Generate a native reply.',
        });
        const generated = probe.requests.slice(start);
        expect(generated).toHaveLength(1);
        const compactStart = probe.requests.length;
        await probe.client.session.compact({ sessionID: session.id });
        await probe.client.session.wait(
          { sessionID: session.id },
          { signal: AbortSignal.timeout(60_000) },
        );
        const compacted = probe.requests.slice(compactStart);
        // The absent host makes a compaction request and a normal continuation.
        expect(compacted).toHaveLength(2);
        results.push(
          fixturePaths(
            {
              generated: generated.map((request) => nativeRequest(request.body, probe)),
              compacted: compacted.map((request) => nativeRequest(request.body, probe)),
            },
            probe,
          ),
        );
        await probe.unchanged();
      }
      expect(results[1]).toEqual(results[0]);
    }, 180_000);

    it('preserves the native session shell path independently of model tool calls', async () => {
      for (const probe of arms) {
        const target = join(probe.project, 'native-session-shell.txt');
        await writeFile(target, 'original');
        const session = await probe.session();
        const reply = shellEffect(target);
        if (!reply.tool) throw new Error('Missing shell fixture');
        await probe.client.session.shell({
          sessionID: session.id,
          command: String(reply.tool.arguments.command),
        });
        await probe.client.session.wait(
          { sessionID: session.id },
          { signal: AbortSignal.timeout(60_000) },
        );
        expect(await readFile(target, 'utf8'), probe.output()).toBe('native-effect');
        expect(
          (await probe.client.session.context({ sessionID: session.id })).some(
            (message) => message.type === 'shell',
          ),
        ).toBe(true);
        await probe.unchanged();
      }
    }, 180_000);

    it('does not implicitly activate or hydrate from model-supplied workflow tool calls', async () => {
      for (const probe of arms) {
        const session = await probe.session();
        probe.scripts.set(session.id, [{ tool: { name: 'flowguard_hydrate', arguments: {} } }]);
        await probe.prompt(session.id, 'Start governance by calling hydrate.');
        expect(
          (await terminalTools(probe, session.id, 'flowguard_hydrate')).map(
            (part) => part.state.status,
          ),
        ).toEqual(['error']);
        for (const request of probe.requests.filter((request) => request.sessionID === session.id))
          expect(
            nativeTools(request.body)
              .map((tool) => tool.function.name)
              .some((name) => name.startsWith('flowguard_')),
          ).toBe(false);
        await probe.unchanged();
      }
    }, 180_000);

    it('keeps the explicitly permitted help affordance inert without publishing workflow tools', async () => {
      const installed = arms[1]!;
      const session = await installed.session();
      installed.scripts.set(session.id, [
        { tool: { name: TOOL_FLOWGUARD_HELP, arguments: { view: 'context' } } },
      ]);
      await installed.prompt(session.id, 'Show the explicitly requested FlowGuard help.');
      expect(
        (await terminalTools(installed, session.id, TOOL_FLOWGUARD_HELP)).map(
          (part) => part.state.status,
        ),
      ).toEqual(['completed']);
      for (const request of installed.requests.filter(
        (request) => request.sessionID === session.id,
      ))
        expect(
          nativeTools(request.body).some((tool) => tool.function.name.startsWith('flowguard_')),
        ).toBe(false);
      await installed.unchanged();
    }, 180_000);

    it('remains INACTIVE across host restart without hydration or context injection', async () => {
      const results = [];
      for (const probe of arms) {
        await probe.restart();
        const session = await probe.session();
        await probe.prompt(session.id, 'Reply without tools after restart.');
        const body = probe.requests.filter((request) => request.sessionID === session.id)[0]!.body;
        results.push(fixturePaths({ messages: body.messages, tools: nativeTools(body) }, probe));
        await probe.unchanged();
      }
      expect(results[1]).toEqual(results[0]);
    }, 180_000);
  });
});
