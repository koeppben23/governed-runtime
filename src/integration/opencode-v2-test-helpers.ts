/** Native V2 boundary fixtures only. These are not installed-host provenance evidence. */
import { vi, type Mock } from 'vitest';
import type { Plugin } from '@opencode/plugin';
import type { OpenCodeEvent } from '@opencode/client';
import type { OrchestratorClient } from './review/types.js';

/** Explicit semantic port mock; unspecified operations fail, never manufacture evidence. */
export function createReviewClient(
  overrides: Partial<OrchestratorClient> = {},
): OrchestratorClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('Unconfigured review host operation');
  };
  return {
    listAgents: vi.fn(unavailable),
    getSession: vi.fn(unavailable),
    readHistory: vi.fn(unavailable),
    interrupt: vi.fn(unavailable),
    quiescence: vi.fn(unavailable),
    reviewerCall: vi.fn(unavailable),
    executeReviewerPrompt: vi.fn(unavailable),
    ...overrides,
  };
}

type Callback = (event: unknown) => Promise<void> | void;
type Item = { event: OpenCodeEvent } | { error: unknown } | { end: true };

export function createV2Host(directory: string) {
  const toolHooks = new Map<string, Callback>();
  const sessionHooks = new Map<string, Callback>();
  const definitions = new Map<
    string,
    {
      name: string;
      description: string;
      input: unknown;
      execute(input: unknown, context: unknown): Promise<unknown>;
    }
  >();
  const registrations: Array<{ dispose: Mock<() => Promise<void>> }> = [];
  let failRegistration = 0;
  let registrationCount = 0;
  const register = () => {
    registrationCount++;
    if (registrationCount === failRegistration) throw new Error('registration failed');
    const registration = { dispose: vi.fn(async () => {}) };
    registrations.push(registration);
    return registration;
  };
  const items: Item[] = [];
  let next: ((item: Item) => void) | undefined;
  let stopped = false;
  const send = (item: Item) => {
    if (next) {
      const resolve = next;
      next = undefined;
      resolve(item);
    } else items.push(item);
  };
  const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => {
    const close = () => {
      stopped = true;
      send({ end: true });
    };
    signal.addEventListener('abort', close, { once: true });
    return (async function* () {
      try {
        while (!stopped) {
          const item =
            items.shift() ??
            (await new Promise<Item>((resolve) => {
              next = resolve;
            }));
          if ('end' in item) return;
          if ('error' in item) throw item.error;
          yield item.event;
        }
      } finally {
        signal.removeEventListener('abort', close);
      }
    })();
  });
  const sessionGet = vi.fn(async ({ sessionID }: { sessionID: string }) => ({
    id: sessionID,
    parentID: 'parent',
    location: { directory },
  }));
  const sessionContext = vi.fn(async (_input: unknown) => [] as unknown[]);
  const interrupt = vi.fn(async (_input: unknown) => ({ interrupted: true }));
  const prompt = vi.fn(async (_input: unknown) => ({ id: 'inbox', type: 'user' }));
  const listAgents = vi.fn(async () => ({
    location: { directory },
    data: [{ id: 'flowguard-reviewer' }],
  }));
  const context = {
    app: { name: 'opencode', version: '2.2.4', channel: 'stable' },
    location: { directory, project: { id: 'project', directory, canonical: directory } },
    options: {},
    agent: { list: listAgents },
    session: {
      get: sessionGet,
      context: sessionContext,
      interrupt,
      prompt,
      hook: vi.fn(async (name: string, callback: Callback) => {
        const registration = register();
        sessionHooks.set(name, callback);
        return registration;
      }),
    },
    tool: {
      hook: vi.fn(async (name: string, callback: Callback) => {
        const registration = register();
        toolHooks.set(name, callback);
        return registration;
      }),
      transform: vi.fn(async (transform: (editor: { add(tool: unknown): void }) => void) => {
        const registration = register();
        transform({
          add(tool) {
            const definition = tool as typeof definitions extends Map<string, infer T> ? T : never;
            definitions.set(definition.name, definition);
          },
        });
        return registration;
      }),
    },
    event: { subscribe },
    command: { transform: vi.fn(async (_input: unknown) => {}) },
  };
  return {
    ctx: context as unknown as Plugin.Context,
    context,
    registrations,
    toolHooks,
    sessionHooks,
    definitions,
    sessionGet,
    sessionContext,
    interrupt,
    prompt,
    listAgents,
    subscribe,
    failAt: (index: number) => {
      failRegistration = index;
    },
    emit: (event: unknown) => send({ event: event as OpenCodeEvent }),
    failEvents: (error: unknown) => send({ error }),
    endEvents: () => send({ end: true }),
    before: async (event: unknown) => {
      await toolHooks.get('execute.before')!(event);
    },
    after: async (event: unknown) => {
      await toolHooks.get('execute.after')!(event);
    },
    request: async (event: unknown) => {
      await sessionHooks.get('context')!(event);
    },
    compact: async (event: unknown) => {
      await sessionHooks.get('compaction')!(event);
    },
  };
}

export function v2ToolEvent(patch: Record<string, unknown> = {}) {
  return {
    tool: 'read',
    sessionID: 'session',
    agent: 'build',
    messageID: 'message',
    id: 'call',
    input: { filePath: 'README.md' },
    ...patch,
  };
}
