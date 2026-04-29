/**
 * @module integration/command-aliases
 * @description Deterministic one-way product→canonical command resolution.
 *
 * Aliases are a presentation/integration facade only.
 * Canonical commands remain the SSOT in machine, state, audit, and reason codes.
 *
 * Architecture:
 *   User alias input
 *        ↓
 *   resolveCommandAlias(input)
 *        ↓
 *   canonical command + optional defaultArgs
 *        ↓
 *   existing: command policy → state machine → rails → audit
 *
 * @version v1
 */

// ─── Resolution Type ──────────────────────────────────────────────────────────

export type CommandAliasResolution = Readonly<{
  /** The canonical command name (SSOT from src/machine/commands.ts). */
  canonicalCommand: string;
  /** Pre-filled arguments forwarded to the canonical command tool. */
  defaultArgs?: Readonly<Record<string, unknown>>;
  /** Human-readable label for product documentation and status output. */
  productLabel: string;
}>;

// ─── Alias Registry ───────────────────────────────────────────────────────────

/**
 * Product→canonical alias map.
 *
 * Only genuine product aliases belong here. Canonical commands that are already
 * product-friendly (plan, implement, architecture, review, status) pass through
 * unchanged via the fallback case in resolveCommandAlias().
 *
 * Rule: no passthrough entry for canonical commands — they resolve naturally.
 */
const COMMAND_ALIASES: Readonly<Record<string, CommandAliasResolution>> = {
  start: {
    canonicalCommand: 'hydrate',
    productLabel: 'Start governed task',
  },
  task: {
    canonicalCommand: 'ticket',
    productLabel: 'Capture task',
  },
  approve: {
    canonicalCommand: 'review-decision',
    defaultArgs: { verdict: 'approve' },
    productLabel: 'Approve current review gate',
  },
  'request-changes': {
    canonicalCommand: 'review-decision',
    defaultArgs: { verdict: 'changes_requested' },
    productLabel: 'Request changes',
  },
  reject: {
    canonicalCommand: 'review-decision',
    defaultArgs: { verdict: 'reject' },
    productLabel: 'Reject current review gate',
  },
  check: {
    canonicalCommand: 'validate',
    productLabel: 'Check evidence',
  },
  export: {
    canonicalCommand: 'archive',
    productLabel: 'Export audit package',
  },
  why: {
    canonicalCommand: 'status',
    defaultArgs: { whyBlocked: true },
    productLabel: 'Explain blocker',
  },
};

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Strip leading slash and normalize whitespace from a command name.
 */
function normalizeCommandName(input: string): string {
  return input.trim().replace(/^\//, '');
}

/**
 * Resolve a user-facing command input (with or without leading `/`) to its
 * canonical command and optional default arguments.
 *
 * - Known product aliases → typed resolution with canonical command + defaultArgs.
 * - Everything else (canonical commands, typos, unknowns) → passthrough with the
 *   input as both canonicalCommand and productLabel. The downstream command policy
 *   or tool routing rejects unknown commands fail-closed.
 *
 * This function is a pure one-way mapping. It never mutates, never depends on
 * runtime state, and never creates a second source of truth.
 */
export function resolveCommandAlias(input: string): CommandAliasResolution {
  const normalized = normalizeCommandName(input);
  return (
    COMMAND_ALIASES[normalized] ?? {
      canonicalCommand: normalized,
      productLabel: normalized,
    }
  );
}

/**
 * Convenience: resolve a command alias and return only the canonical command name.
 */
export function canonicalCommandName(input: string): string {
  return resolveCommandAlias(input).canonicalCommand;
}
