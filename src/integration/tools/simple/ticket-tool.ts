/**
 * @module integration/tools/simple/ticket-tool
 * @description FlowGuard ticket tool — records task/ticket description for the session.
 *
 * Two canonical content sources are supported and mutually exclusive:
 * - `text`: the complete ticket content (typed in chat or explicitly adopted
 *   external content),
 * - `ticketSource` (`repository_file`): the runtime reads the repository file
 *   itself and binds its content digest — a reference alone is never content.
 *
 * @version v1
 */

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../helpers.js';
import { formatError } from '../error-format.js';
import { formatBlocked } from '../../blocked-result.js';
import { withMutableSessionTransaction } from '../helpers.js';
import type { ToolResult } from '../helpers.js';
import { persistAndFormat } from '../helpers-rail-presentation.js';
import { executeTicket } from '../../../rails/ticket.js';
import { InputOriginSchema, ExternalReferenceSchema } from '../../../state/evidence.js';
import { ActorClaimError } from '../../../adapters/actor.js';

// ─── Shared safe-execution wrapper ───────────────────────────────────────────

/**
 * Wraps a tool execution with error handling.
 * ActorClaimError is surfaced as a blocked response when configured.
 */
export async function safeExecute(
  fn: () => Promise<ToolResult>,
  opts: { actorClaimErrorAsBlocked: boolean },
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (opts.actorClaimErrorAsBlocked && err instanceof ActorClaimError) {
      return formatBlocked(err.code);
    }
    return formatError(err);
  }
}

// ─── Reference-without-content backstop ──────────────────────────────────────

/** A path-like token contains a separator or carries a file extension. */
function isPathLikeToken(token: string): boolean {
  return token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token);
}

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[),.;:!?]+$/, '');
}

function isBareUrlToken(token: string): boolean {
  return /^https?:\/\//i.test(token);
}

/**
 * Fail-closed backstop against storing a mere reference as the ticket.
 *
 * Detection is syntactic and deliberately independent of file existence: a
 * typo in a referenced path must not bypass content adoption. Only dominant
 * reference forms trigger (the whole text is a reference, or the text starts
 * with a read/load instruction on a path-like token); prose that merely
 * mentions a filename stays a regular ticket.
 */
function isUnadoptedTicketReference(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  const single = stripTrailingPunctuation(trimmed);
  if (!single.includes(' ') && (isPathLikeToken(single) || isBareUrlToken(single))) {
    return true;
  }

  const instruction = /^(?:please\s+)?(?:read|open|load|resolve|use)\s+(\S+)/i.exec(trimmed);
  if (instruction !== null) {
    const target = stripTrailingPunctuation(instruction[1] ?? '');
    if (isPathLikeToken(target) || isBareUrlToken(target)) return true;
  }

  return false;
}

// ─── Repository file adoption ────────────────────────────────────────────────

function readRepositoryTicketFile(
  worktree: string,
  path: string,
): { readonly kind: 'ok'; readonly content: string } | { readonly kind: 'error'; reason: string } {
  let root: string;
  let target: string;
  try {
    // Canonicalize both sides: a lexical check alone would let an in-worktree
    // symlink point at a file outside the worktree, and `readFileSync` would
    // happily follow it.
    root = realpathSync(resolve(worktree));
    target = realpathSync(isAbsolute(path) ? resolve(path) : resolve(root, path));
  } catch (err) {
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  const rel = relative(root, target);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    return { kind: 'error', reason: `path escapes the worktree: ${path}` };
  }
  try {
    return { kind: 'ok', content: readFileSync(target, 'utf-8') };
  } catch (err) {
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── flowguard_ticket ────────────────────────────────────────────────────────

export const ticket: ToolDefinition = {
  description:
    'Record the task/ticket description for the FlowGuard session. ' +
    'Clears all downstream evidence (plan, validation, implementation). ' +
    'Pass exactly one canonical content source: text, or ticketSource for a ' +
    'repository file whose content the runtime reads and digest-binds. ' +
    'Allowed in READY and TICKET phases.',
  args: {
    text: z
      .string()
      .optional()
      .describe(
        'The complete ticket content (typed in chat, or explicitly adopted external ' +
          'content). Mutually exclusive with ticketSource.',
      ),
    ticketSource: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('repository_file'),
          path: z.string().min(1),
        }),
      ])
      .optional()
      .describe(
        'Repository file whose content becomes the canonical ticket text. The runtime ' +
          'reads the file (must stay inside the worktree) and binds its content digest. ' +
          'Mutually exclusive with text.',
      ),
    source: z
      .enum(['user', 'external'])
      .default('user')
      .describe("Source of the ticket: 'user' (typed in chat) or 'external' (from issue tracker)."),
    inputOrigin: InputOriginSchema.optional().describe(
      'Where the text content originated. Set to "external_reference" when text was extracted ' +
        'from a URL, "manual_text" when typed, "mixed" when both manual and external.',
    ),
    references: z
      .array(ExternalReferenceSchema)
      .optional()
      .describe(
        'External references for this ticket (Jira URL, GitHub issue, Confluence doc, etc.). ' +
          'Each reference has ref (URL/ID), type (ticket/issue/pr/branch/commit/url/doc/other), ' +
          'optional title, source platform, and extractedAt timestamp.',
      ),
  },
  async execute(args, context) {
    return safeExecute(
      async () => {
        return withMutableSessionTransaction(
          context,
          async ({ worktree, sessDir, state, ctx }): Promise<ToolResult> => {
            const rawText = args.text;
            const ticketSource = args.ticketSource;
            const hasText = typeof rawText === 'string' && rawText.trim().length > 0;
            if (hasText && ticketSource !== undefined) {
              return formatBlocked('TICKET_SOURCE_CONFLICT');
            }

            let text: string;
            let inputOrigin = args.inputOrigin;
            let references = args.references;

            if (ticketSource !== undefined) {
              const adopted = readRepositoryTicketFile(worktree, ticketSource.path);
              if (adopted.kind === 'error') {
                return formatBlocked('TICKET_SOURCE_UNREADABLE', { reason: adopted.reason });
              }
              if (adopted.content.trim().length === 0) {
                return formatBlocked('EMPTY_TICKET');
              }
              text = adopted.content;
              inputOrigin = inputOrigin ?? 'workspace';
              const fileRef = { ref: ticketSource.path, type: 'doc' as const };
              references = [
                fileRef,
                ...(references ?? []).filter(
                  (reference: { readonly ref: string }) => reference.ref !== fileRef.ref,
                ),
              ];
            } else if (typeof rawText === 'string' && hasText) {
              text = rawText;
              if (isUnadoptedTicketReference(text)) {
                return formatBlocked('TICKET_REFERENCE_WITHOUT_CONTENT');
              }
            } else {
              return formatBlocked('EMPTY_TICKET');
            }

            const result = executeTicket(
              state,
              {
                text,
                source: args.source,
                inputOrigin,
                references,
              },
              ctx,
            );
            return persistAndFormat(sessDir, result);
          },
        );
      },
      { actorClaimErrorAsBlocked: true },
    );
  },
};
