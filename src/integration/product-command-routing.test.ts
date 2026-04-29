/**
 * @test-policy
 * HAPPY: product aliases route through command policy correctly (approve in review phases,
 *        check in VALIDATION, export in COMPLETE).
 * BAD: approve in non-review phase is blocked, reject without review gate is blocked.
 * CORNER: canonical commands are unaffected — same policy logic applies regardless of alias input.
 * EDGE: alias passthrough unknowns are rejected by the command policy fail-closed.
 * PERF: not applicable; pure function under test.
 */
import { describe, expect, it } from 'vitest';
import { canonicalCommandName } from './command-aliases.js';
import { isCommandAllowed, Command } from '../machine/commands.js';
import type { Phase } from '../state/schema.js';

function isAliasAllowed(phase: Phase, aliasInput: string): boolean {
  const canonical = canonicalCommandName(aliasInput);
  // Must match a known Command enum value — otherwise fail-closed
  const cmd = canonical as (typeof Command)[keyof typeof Command];
  if (!Object.values(Command).includes(cmd)) return false;
  return isCommandAllowed(phase, cmd);
}

describe('alias → command policy integration', () => {
  describe('HAPPY — aliases pass through command policy', () => {
    it('/start is allowed in READY (maps to hydrate, allowed in all phases)', () => {
      expect(isAliasAllowed('READY', 'start')).toBe(true);
    });

    it('/task is allowed in READY (maps to ticket)', () => {
      expect(isAliasAllowed('READY', 'task')).toBe(true);
    });

    it('/task is allowed in TICKET (maps to ticket)', () => {
      expect(isAliasAllowed('TICKET', 'task')).toBe(true);
    });

    it('/plan is allowed in TICKET (passthrough canonical)', () => {
      expect(isAliasAllowed('TICKET', 'plan')).toBe(true);
    });

    it('/approve is allowed in PLAN_REVIEW (maps to review-decision)', () => {
      expect(isAliasAllowed('PLAN_REVIEW', 'approve')).toBe(true);
    });

    it('/approve is allowed in EVIDENCE_REVIEW', () => {
      expect(isAliasAllowed('EVIDENCE_REVIEW', 'approve')).toBe(true);
    });

    it('/approve is allowed in ARCH_REVIEW', () => {
      expect(isAliasAllowed('ARCH_REVIEW', 'approve')).toBe(true);
    });

    it('/request-changes is allowed in PLAN_REVIEW', () => {
      expect(isAliasAllowed('PLAN_REVIEW', 'request-changes')).toBe(true);
    });

    it('/reject is allowed in PLAN_REVIEW', () => {
      expect(isAliasAllowed('PLAN_REVIEW', 'reject')).toBe(true);
    });

    it('/check is allowed in VALIDATION (maps to validate)', () => {
      expect(isAliasAllowed('VALIDATION', 'check')).toBe(true);
    });

    it('/export maps to archive; enforcement is handled by flowguard_archive', () => {
      // archive is not in the Command enum, it's a template-only command.
      // But /hydrate IS the canonical for /start, and /export maps to archive.
      // archive tool is not admissibility-gated via isCommandAllowed — it's a
      // template-layer tool. The command policy only gates the 10 canonical commands.
      // We test that the alias maps correctly; the archive tool itself routes
      // through the simple-tools layer which has its own checks.
      expect(canonicalCommandName('export')).toBe('archive');
    });
  });

  describe('BAD — aliases are blocked where canonical command is blocked', () => {
    it('/approve in TICKET is blocked (review-decision not allowed)', () => {
      expect(isAliasAllowed('TICKET', 'approve')).toBe(false);
    });

    it('/approve in IMPLEMENTATION is blocked', () => {
      expect(isAliasAllowed('IMPLEMENTATION', 'approve')).toBe(false);
    });

    it('/approve in COMPLETE is blocked (terminal, mutating)', () => {
      expect(isAliasAllowed('COMPLETE', 'approve')).toBe(false);
    });

    it('/reject in READY is blocked', () => {
      expect(isAliasAllowed('READY', 'reject')).toBe(false);
    });

    it('/request-changes in VALIDATION is blocked', () => {
      expect(isAliasAllowed('VALIDATION', 'request-changes')).toBe(false);
    });

    it('/check in READY is blocked (validate not allowed)', () => {
      expect(isAliasAllowed('READY', 'check')).toBe(false);
    });
  });

  describe('CORNER — canonical commands behaviour unchanged', () => {
    it('canonical review-decision is blocked in TICKET, same as /approve', () => {
      expect(isCommandAllowed('TICKET', Command.REVIEW_DECISION)).toBe(false);
      expect(isAliasAllowed('TICKET', 'approve')).toBe(false);
    });

    it('canonical validate is allowed in VALIDATION, same as /check', () => {
      expect(isCommandAllowed('VALIDATION', Command.VALIDATE)).toBe(true);
      expect(isAliasAllowed('VALIDATION', 'check')).toBe(true);
    });
  });

  describe('EDGE — unknown aliases are fail-closed', () => {
    it('unknown command not in Command enum returns false', () => {
      expect(isAliasAllowed('READY', 'foobar')).toBe(false);
    });

    it('alias for non-existent canonical returns false', () => {
      // Use an alias that passes through to an unknown canonical
      expect(canonicalCommandName('nonexistent')).toBe('nonexistent');
      expect(isAliasAllowed('READY', 'nonexistent')).toBe(false);
    });
  });
});
