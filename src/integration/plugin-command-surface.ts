/**
 * @module integration/plugin-command-surface
 * @description Native OpenCode command surface for every installed FlowGuard
 * command. The full canonical instruction body is injected into the model
 * request's system context; the durable user message carries only the invoked
 * command and the user's arguments. This is presentation and transport only:
 * it never authorizes a workflow action, changes phase admissibility, or
 * replaces a canonical tool/state transition.
 */

import type { Plugin } from '@opencode/plugin';
import type { SessionContext } from '@opencode/plugin/promise/session';
import { CHECK_COMMAND } from '../templates/commands/check.js';
import { COMMANDS } from '../templates/commands/index.js';
import { INSTALLED_COMMANDS } from './installed-commands.js';

/** Admission marker for a native FlowGuard command prompt. */
export const COMMAND_PROMPT_SOURCE = 'flowguard-command';
/** System-part marker for the injected canonical command instructions. */
export const COMMAND_INSTRUCTIONS_SOURCE = 'flowguard-command-instructions';

const FRONTMATTER = /^---[\s\S]*?---\n+/;

/** Installed template body without host frontmatter. */
function commandTemplateBody(template: string): string {
  return template.replace(FRONTMATTER, '').trim();
}

/**
 * The canonical instruction text that reaches the model. `$ARGUMENTS` is a
 * host-template placeholder; native commands deliver arguments in the visible
 * user message instead, so the system body must not pretend to contain them.
 */
export function commandInstructionBody(template: string): string {
  return commandTemplateBody(template).replaceAll(
    '$ARGUMENTS',
    '(The user-supplied command arguments are in the visible command message.)',
  );
}

const COMMAND_INSTRUCTIONS = new Map<string, string>();
for (const [file, template] of Object.entries(COMMANDS)) {
  COMMAND_INSTRUCTIONS.set(file.replace(/\.md$/, ''), commandInstructionBody(template));
}
COMMAND_INSTRUCTIONS.set('check', commandInstructionBody(CHECK_COMMAND));

/** Visible user prompt: only the command and its user-supplied arguments. */
export function visibleCommandText(name: string, args: string): string {
  const trimmed = args.trim();
  return trimmed.length === 0 ? `/${name}` : `/${name} ${trimmed}`;
}

/** One native registration per canonical command identity, in catalogue order. */
export function installedCommandSurface(): readonly {
  readonly name: string;
  readonly description: string;
}[] {
  const seen = new Set<string>();
  const surface: { name: string; description: string }[] = [];
  for (const definition of INSTALLED_COMMANDS) {
    if (definition.templateFile === null) continue;
    const name = definition.invocation.slice(1).split(/\s+/, 1)[0];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    surface.push({ name, description: definition.description });
  }
  return surface;
}

/** Request message shape owned by the host session contract. */
export type CommandContextMessage = SessionContext['messages'][number];

type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];
type NativePromptInput = Parameters<Plugin.Context['session']['prompt']>[0];

type CommandPrompt = {
  readonly text: string;
  readonly files?:
    | readonly {
        readonly uri: string;
        readonly source?:
          { readonly type: 'inline' } | { readonly type: 'uri'; readonly uri: string } | undefined;
        readonly name?: string | undefined;
        readonly description?: string | undefined;
        readonly mention?:
          { readonly start: number; readonly end: number; readonly text: string } | undefined;
      }[]
    | undefined;
  readonly agents?:
    | readonly {
        readonly name: string;
        readonly mention?:
          { readonly start: number; readonly end: number; readonly text: string } | undefined;
      }[]
    | undefined;
  readonly skills?:
    | readonly {
        readonly id: string;
        readonly mention?:
          { readonly start: number; readonly end: number; readonly text: string } | undefined;
      }[]
    | undefined;
};

/** Exact-optional projection: host prompt inputs allow `undefined`, the native
 * prompt schema does not. Omit absent fields instead of forwarding undefined. */
function promptAttachments(
  prompt: CommandPrompt,
): Pick<NativePromptInput, 'files' | 'agents' | 'skills'> {
  return {
    ...(prompt.files === undefined
      ? {}
      : {
          files: prompt.files.map((file) => ({
            uri: file.uri,
            ...(file.source === undefined ? {} : { source: file.source }),
            ...(file.name === undefined ? {} : { name: file.name }),
            ...(file.description === undefined ? {} : { description: file.description }),
            ...(file.mention === undefined ? {} : { mention: file.mention }),
          })),
        }),
    ...(prompt.agents === undefined
      ? {}
      : {
          agents: prompt.agents.map((agent) => ({
            name: agent.name,
            ...(agent.mention === undefined ? {} : { mention: agent.mention }),
          })),
        }),
    ...(prompt.skills === undefined
      ? {}
      : {
          skills: prompt.skills.map((skill) => ({
            id: skill.id,
            ...(skill.mention === undefined ? {} : { mention: skill.mention }),
          })),
        }),
  };
}

export interface CommandSurfaceDeps {
  readonly guard: <T>(run: () => Promise<T>) => Promise<T>;
}

/**
 * Present a native command result as a short synthetic status notice. It is not
 * a user prompt and does not create a user-authored transcript entry. OpenCode
 * delivers `resume:true` immediately and starts one turn; the summary therefore
 * stays short and leaves the full canonical detail to `/status`.
 */
export async function presentCommandStatus(
  ctx: Pick<Plugin.Context, 'session'>,
  sessionID: string,
  summary: string,
): Promise<void> {
  await ctx.session.synthetic({
    sessionID,
    text: `${summary}\n\nStatus only. Do not run another command; wait for the user's explicit command.`,
    description: 'FlowGuard status',
    resume: true,
  });
}

/**
 * Register every installed template command natively. The host never expands a
 * Markdown template into the transcript; the command prompt stays short and
 * the canonical body is supplied by {@link injectCommandInstructions}.
 */
export function addInstalledCommandSurface(
  ctx: Pick<Plugin.Context, 'session'>,
  deps: CommandSurfaceDeps,
  editor: CommandEditor,
): void {
  for (const command of installedCommandSurface()) {
    editor.add({
      name: command.name,
      description: `FlowGuard — ${command.description}`,
      execute: (input) =>
        deps.guard(async () => {
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: visibleCommandText(command.name, input.prompt.text),
            delivery: input.delivery,
            ...promptAttachments(input.prompt),
            metadata: { source: COMMAND_PROMPT_SOURCE, command: command.name },
          });
        }),
    });
  }
}

function userMessageText(message: CommandContextMessage): string | null {
  if (message.role !== 'user') return null;
  const text: string[] = [];
  for (const part of message.content) {
    if (part.type === 'text') text.push(part.text);
  }
  return text.join('\n');
}

function latestUserText(messages: readonly CommandContextMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined || message.role !== 'user') continue;
    return userMessageText(message);
  }
  return null;
}

/**
 * Inject the canonical instructions for the command that owns the latest user
 * message. Tool-driven continuations keep the same latest user message, so the
 * body applies for the whole turn. A later ordinary prompt no longer matches,
 * which removes the instruction naturally without durable session state.
 */
export function injectCommandInstructions(
  event: Pick<SessionContext, 'messages' | 'system'>,
): void {
  // Older host fixtures and auxiliary requests can omit either field. Missing
  // request structure is not a command prompt; never turn it into a failure.
  if (!Array.isArray(event.messages) || !Array.isArray(event.system)) return;
  const text = latestUserText(event.messages);
  if (text === null) return;
  const match = /^\/([A-Za-z0-9-]+)(?:\s|$)/.exec(text);
  const name = match?.[1];
  if (name === undefined) return;
  const body = COMMAND_INSTRUCTIONS.get(name);
  if (body === undefined) return;
  if (
    event.system.some(
      (part) =>
        part.metadata?.['source'] === COMMAND_INSTRUCTIONS_SOURCE &&
        part.metadata['command'] === name,
    )
  )
    return;
  event.system.push({
    type: 'text',
    text: `# FlowGuard command: /${name}\n\n${body}`,
    metadata: { source: COMMAND_INSTRUCTIONS_SOURCE, command: name },
  });
}
