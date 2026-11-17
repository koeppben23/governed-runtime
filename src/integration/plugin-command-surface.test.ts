import { describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@opencode/plugin';
import {
  addInstalledCommandSurface,
  commandInstructionBody,
  COMMAND_INSTRUCTIONS_SOURCE,
  COMMAND_PROMPT_SOURCE,
  injectCommandInstructions,
  installedCommandSurface,
  visibleCommandText,
  type CommandContextMessage,
} from './plugin-command-surface.js';
import { COMMANDS } from '../templates/commands/index.js';
import { executeCheckCommand } from './plugin-check-command.js';

type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];
type AddedCommand = {
  readonly name: string;
  readonly description: string;
  readonly execute: (input: {
    readonly sessionID: string;
    readonly prompt: {
      readonly text: string;
      readonly files?: readonly { readonly uri: string }[];
      readonly agents?: readonly { readonly name: string }[];
      readonly skills?: readonly { readonly id: string }[];
    };
    readonly delivery: 'steer' | 'queue';
  }) => Promise<void>;
};

function user(text: string): CommandContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  } as unknown as CommandContextMessage;
}

function assistant(text: string): CommandContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as CommandContextMessage;
}

function surfaceEvent(messages: readonly CommandContextMessage[]) {
  return {
    messages: [...messages],
    system: [] as { type: 'text'; text: string; metadata?: Record<string, unknown> }[],
  };
}

function installSurface() {
  const added: AddedCommand[] = [];
  const prompt = vi.fn(async () => undefined);
  const guardSpy = vi.fn();
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    guardSpy();
    return run();
  };
  const editor = {
    add: (definition: AddedCommand) => added.push(definition),
  } as unknown as CommandEditor;
  addInstalledCommandSurface({ session: { prompt } } as never, { guard }, editor);
  return { added, prompt, guard: guardSpy };
}

describe('installed command surface', () => {
  it('registers every installed template command exactly once', () => {
    const surface = installedCommandSurface();
    const templateNames = Object.keys(COMMANDS).map((file) => file.replace(/\.md$/, ''));
    expect(surface.map((command) => command.name).sort()).toEqual([...templateNames].sort());
    expect(new Set(surface.map((command) => command.name)).size).toBe(surface.length);
    expect(surface.some((command) => command.name === 'check')).toBe(false);
    expect(surface.some((command) => command.name === 'start')).toBe(false);
  });

  it('renders only the invoked command and its user arguments', () => {
    expect(visibleCommandText('implement', '')).toBe('/implement');
    expect(visibleCommandText('task', '  Fix the lock  ')).toBe('/task Fix the lock');
    expect(visibleCommandText('status', '--why-blocked')).toBe('/status --why-blocked');
  });

  it('keeps the canonical body and neutralizes the host argument placeholder', () => {
    const body = commandInstructionBody(COMMANDS['task.md']!);
    expect(body).not.toMatch(/^---/);
    expect(body).not.toContain('$ARGUMENTS');
    expect(body).toContain('user-supplied command arguments are in the visible command message');
    expect(body).toContain('flowguard_ticket');
  });

  it('submits a short prompt with provenance for every command', async () => {
    const { added, prompt, guard } = installSurface();
    const implement = added.find((command) => command.name === 'implement');
    expect(implement).toBeDefined();
    await implement!.execute({
      sessionID: 'ses_test',
      prompt: { text: '' },
      delivery: 'queue',
    });
    expect(guard).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith({
      sessionID: 'ses_test',
      text: '/implement',
      delivery: 'queue',
      metadata: { source: COMMAND_PROMPT_SOURCE, command: 'implement' },
    });
  });

  it('preserves user arguments, attachments, mentions and delivery', async () => {
    const { added, prompt } = installSurface();
    const task = added.find((command) => command.name === 'task');
    const files = [{ uri: 'file:///workspace/TICKET.md' }];
    const agents = [{ name: 'build' }];
    const skills = [{ id: 'review' }];
    await task!.execute({
      sessionID: 'ses_test',
      prompt: { text: 'Fix the lock', files, agents, skills },
      delivery: 'steer',
    });
    expect(prompt).toHaveBeenCalledWith({
      sessionID: 'ses_test',
      text: '/task Fix the lock',
      delivery: 'steer',
      files,
      agents,
      skills,
      metadata: { source: COMMAND_PROMPT_SOURCE, command: 'task' },
    });
  });
});

describe('command instruction injection', () => {
  it('injects the canonical body for the latest command prompt', () => {
    const event = surfaceEvent([assistant('earlier'), user('/implement')]);
    injectCommandInstructions(event);
    expect(event.system).toHaveLength(1);
    expect(event.system[0]!.metadata).toEqual({
      source: COMMAND_INSTRUCTIONS_SOURCE,
      command: 'implement',
    });
    expect(event.system[0]!.text).toContain('FlowGuard-controlled development workflow');
    expect(event.system[0]!.text).toContain('flowguard_implement');
  });

  it('injects the check body for the native check command', () => {
    const event = surfaceEvent([user('/check')]);
    injectCommandInstructions(event);
    expect(event.system[0]!.metadata).toMatchObject({ command: 'check' });
    expect(event.system[0]!.text).toContain('flowguard_run_check');
  });

  it('does not apply an older command body to a later ordinary prompt', () => {
    const event = surfaceEvent([user('/implement'), assistant('done'), user('Thanks')]);
    injectCommandInstructions(event);
    expect(event.system).toEqual([]);
  });

  it('does not inject for native commands without an installed body', () => {
    const event = surfaceEvent([user('/start')]);
    injectCommandInstructions(event);
    expect(event.system).toEqual([]);
  });

  it('does not inject for ordinary prose that mentions a command later', () => {
    const event = surfaceEvent([user('Why did /implement stop?')]);
    injectCommandInstructions(event);
    expect(event.system).toEqual([]);
  });

  it('does not inject into a reviewer child prompt', () => {
    const event = surfaceEvent([
      user('You are a subagent spawned by another session.\n\nReview the plan.'),
    ]);
    injectCommandInstructions(event);
    expect(event.system).toEqual([]);
  });

  it('matches commands with flags without changing the visible arguments', () => {
    const event = surfaceEvent([user('/status --why-blocked')]);
    injectCommandInstructions(event);
    expect(event.system[0]!.metadata).toMatchObject({ command: 'status' });
  });

  it('never duplicates the same command instructions', () => {
    const event = surfaceEvent([user('/plan')]);
    injectCommandInstructions(event);
    injectCommandInstructions(event);
    expect(event.system).toHaveLength(1);
  });

  it('matches only the latest user message', () => {
    const event = surfaceEvent([user('/plan'), user('/status')]);
    injectCommandInstructions(event);
    expect(event.system[0]!.metadata).toMatchObject({ command: 'status' });
  });
});

describe('native check command', () => {
  it('submits only /check and leaves the canonical body to system context', async () => {
    const prompt = vi.fn(async () => ({ id: 'inbox', type: 'user' }));
    const wait = vi.fn(async () => undefined);
    const ctx = {
      session: {
        get: vi.fn(async () => ({ agent: 'build' })),
        switchAgent: vi.fn(async () => undefined),
        prompt,
        wait,
      },
    };
    const invoke = vi.fn(
      async (
        _sessionID: string,
        action: (entry: {
          runtime: {
            activeCommandScopes: Map<string, string>;
            checkReworkContinuations: Set<string>;
          };
          scope: { sessionId: string; root: { sessionId: string } };
        }) => Promise<void>,
      ) =>
        action({
          runtime: {
            activeCommandScopes: new Map<string, string>(),
            checkReworkContinuations: new Set<string>(),
          },
          scope: { sessionId: 'ses_test', root: { sessionId: 'ses_test' } },
        }),
    );
    await executeCheckCommand(
      ctx as never,
      { guard: <T>(run: () => Promise<T>) => run(), invoke } as never,
      'ses_test',
    );
    expect(prompt).toHaveBeenCalledWith({
      sessionID: 'ses_test',
      text: '/check',
      metadata: { source: 'flowguard-command', command: 'check' },
    });
    expect(wait).toHaveBeenCalledWith({ sessionID: 'ses_test' });
  });
});
