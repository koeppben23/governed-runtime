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
import {
  InputOriginSchema,
  ExternalReferenceSchema,
  type ExternalReference,
  type InputOrigin,
} from '../../../state/evidence.js';
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

/**
 * Remove the decorative quoting a user/agent wraps a referenced path in, so
 * `Read "TICKET_DOCS.md"` and ``Read `TICKET_DOCS.md` `` are recognized as
 * dominant references like their unquoted form.
 */
function stripTokenDecoration(token: string): string {
  return token
    .replace(/^[("'`]+/, '')
    .replace(/[),.;:!?"'`]+$/, '')
    .trim();
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

  const single = stripTokenDecoration(trimmed);
  if (!single.includes(' ') && (isPathLikeToken(single) || isBareUrlToken(single))) {
    return true;
  }

  const instruction = /^(?:please\s+)?(?:read|open|load|resolve|use)\s+(\S+)/i.exec(trimmed);
  if (instruction !== null) {
    const target = stripTokenDecoration(instruction[1] ?? '');
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
            const resolved = resolveCanonicalTicketSource(worktree, args);
            if (resolved.kind === 'blocked') return formatBlocked(resolved.code);
            // Hosts that do not apply the declared arg defaults deliver
            // `source` as undefined; resolve the documented default here so the
            // value never reaches state validation unset.
            const result = executeTicket(
              state,
              {
                text: resolved.text,
                source: args.source ?? 'user',
                ...(resolved.inputOrigin !== undefined
                  ? { inputOrigin: resolved.inputOrigin }
                  : {}),
                ...(resolved.references !== undefined ? { references: resolved.references } : {}),
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

/**
 * Whether the text merely echoes one of the provided external references
 * (same ref string, case-insensitive, or a bare issue-key token matching a
 * reference). Extracted ticket text with real content stays allowed.
 */
function isReferenceEcho(
  text: string,
  references: readonly ExternalReference[] | undefined,
): boolean {
  const trimmed = text.trim();
  if (references === undefined || references.length === 0) return false;
  const candidate = stripTokenDecoration(trimmed);
  if (candidate.length === 0) return false;
  // A bare issue key can never be adopted external content, even when it does
  // not literally equal one of the supplied reference strings.
  if (isBareIssueKey(candidate)) return true;
  const normalized = candidate.toLowerCase();
  return references.some((reference) => reference.ref.trim().toLowerCase() === normalized);
}

/** Bare issue key like `ABC-123` — a reference, never ticket content. */
function isBareIssueKey(text: string): boolean {
  return !text.includes(' ') && /^[A-Z][A-Z0-9]*-\d+$/i.test(text);
}

interface TicketArgs {
  readonly text?: string | undefined;
  readonly ticketSource?: { readonly kind: 'repository_file'; readonly path: string } | undefined;
  readonly inputOrigin?: InputOrigin | undefined;
  readonly references?: ExternalReference[] | undefined;
}

type ResolvedTicketSource =
  | {
      readonly kind: 'ok';
      readonly text: string;
      readonly inputOrigin: InputOrigin | undefined;
      readonly references: ExternalReference[] | undefined;
    }
  | { readonly kind: 'blocked'; readonly code: string };

/**
 * Resolve the exactly-one canonical content source. Mutual exclusivity is
 * source-based, not content-based: any text alongside ticketSource (even an
 * empty string) is a conflict, and a conflicting provenance claim for a
 * runtime-read worktree file is rejected rather than silently overwritten.
 */
function resolveCanonicalTicketSource(worktree: string, args: TicketArgs): ResolvedTicketSource {
  if (args.text !== undefined && args.ticketSource !== undefined) {
    return { kind: 'blocked', code: 'TICKET_SOURCE_CONFLICT' };
  }
  if (args.ticketSource !== undefined) {
    return adoptRepositoryTicketFile(worktree, args);
  }
  if (typeof args.text === 'string' && args.text.trim().length > 0) {
    if (isUnadoptedTicketReference(args.text)) {
      return { kind: 'blocked', code: 'TICKET_REFERENCE_WITHOUT_CONTENT' };
    }
    if (args.inputOrigin === 'external_reference' && isReferenceEcho(args.text, args.references)) {
      // A bare ticket ID echoed as "content" is still a reference, not adopted
      // external content.
      return { kind: 'blocked', code: 'TICKET_REFERENCE_WITHOUT_CONTENT' };
    }
    return {
      kind: 'ok',
      text: args.text,
      inputOrigin: args.inputOrigin,
      references: args.references,
    };
  }
  return { kind: 'blocked', code: 'EMPTY_TICKET' };
}

function adoptRepositoryTicketFile(worktree: string, args: TicketArgs): ResolvedTicketSource {
  const ticketSource = args.ticketSource;
  if (ticketSource === undefined) return { kind: 'blocked', code: 'EMPTY_TICKET' };
  if (args.inputOrigin !== undefined && args.inputOrigin !== 'workspace') {
    return { kind: 'blocked', code: 'TICKET_SOURCE_CONFLICT' };
  }
  const adopted = readRepositoryTicketFile(worktree, ticketSource.path);
  if (adopted.kind === 'error') {
    return { kind: 'blocked', code: 'TICKET_SOURCE_UNREADABLE' };
  }
  if (adopted.content.trim().length === 0) {
    return { kind: 'blocked', code: 'EMPTY_TICKET' };
  }
  const fileRef = { ref: ticketSource.path, type: 'doc' as const };
  return {
    kind: 'ok',
    text: adopted.content,
    inputOrigin: 'workspace',
    references: [
      fileRef,
      ...(args.references ?? []).filter((reference) => reference.ref !== fileRef.ref),
    ],
  };
}
