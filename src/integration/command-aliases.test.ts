/**
 * @test-policy
 * HAPPY: product aliases resolve to canonical commands with correct defaultArgs.
 * HAPPY: canonical commands pass through unchanged.
 * HAPPY: resolveCommandAlias and canonicalCommandName are pure.
 * BAD: unknown commands pass through unchanged (downstream fail-closed).
 * CORNER: leading slash is stripped. uppercase is preserved. empty string passes through.
 * EDGE: approve/reject/request-changes carry correct verdict defaultArgs.
 * PERF: not applicable; pure function, no I/O.
 */
import { describe, expect, it } from 'vitest';
import { canonicalCommandName, resolveCommandAlias } from './command-aliases.js';

describe('resolveCommandAlias', () => {
  describe('HAPPY — product aliases map to canonical commands', () => {
    it('/start → hydrate', () => {
      const result = resolveCommandAlias('start');
      expect(result.canonicalCommand).toBe('hydrate');
      expect(result.defaultArgs).toBeUndefined();
      expect(result.productLabel).toBe('Start governed task');
    });

    it('/task → ticket', () => {
      const result = resolveCommandAlias('task');
      expect(result.canonicalCommand).toBe('ticket');
      expect(result.defaultArgs).toBeUndefined();
    });

    it('/approve → review-decision with verdict approve', () => {
      const result = resolveCommandAlias('approve');
      expect(result.canonicalCommand).toBe('review-decision');
      expect(result.defaultArgs).toEqual({ verdict: 'approve' });
    });

    it('/request-changes → review-decision with verdict changes_requested', () => {
      const result = resolveCommandAlias('request-changes');
      expect(result.canonicalCommand).toBe('review-decision');
      expect(result.defaultArgs).toEqual({ verdict: 'changes_requested' });
    });

    it('/reject → review-decision with verdict reject', () => {
      const result = resolveCommandAlias('reject');
      expect(result.canonicalCommand).toBe('review-decision');
      expect(result.defaultArgs).toEqual({ verdict: 'reject' });
    });

    it('/check → validate', () => {
      const result = resolveCommandAlias('check');
      expect(result.canonicalCommand).toBe('validate');
    });

    it('/export → archive', () => {
      const result = resolveCommandAlias('export');
      expect(result.canonicalCommand).toBe('archive');
    });

    it('//start normalizes to same as /start', () => {
      expect(resolveCommandAlias('//start')).toEqual(resolveCommandAlias('/start'));
      expect(resolveCommandAlias('///start')).toEqual(resolveCommandAlias('/start'));
    });

    it('/why → status with whyBlocked default', () => {
      const result = resolveCommandAlias('why');
      expect(result.canonicalCommand).toBe('status');
      expect(result.defaultArgs).toEqual({ whyBlocked: true });
    });
  });

  describe('HAPPY — canonical commands pass through unchanged', () => {
    it('hydrate', () => {
      expect(canonicalCommandName('hydrate')).toBe('hydrate');
    });
    it('ticket', () => {
      expect(canonicalCommandName('ticket')).toBe('ticket');
    });
    it('plan', () => {
      expect(canonicalCommandName('plan')).toBe('plan');
    });
    it('implement', () => {
      expect(canonicalCommandName('implement')).toBe('implement');
    });
    it('validate', () => {
      expect(canonicalCommandName('validate')).toBe('validate');
    });
    it('review-decision', () => {
      expect(canonicalCommandName('review-decision')).toBe('review-decision');
    });
    it('review', () => {
      expect(canonicalCommandName('review')).toBe('review');
    });
    it('architecture', () => {
      expect(canonicalCommandName('architecture')).toBe('architecture');
    });
    it('archive', () => {
      expect(canonicalCommandName('archive')).toBe('archive');
    });
    it('status', () => {
      expect(canonicalCommandName('status')).toBe('status');
    });
  });

  describe('CORNER — input normalisation', () => {
    it('strips leading slash from aliases', () => {
      expect(canonicalCommandName('/start')).toBe('hydrate');
      expect(canonicalCommandName('/task')).toBe('ticket');
      expect(canonicalCommandName('/approve')).toBe('review-decision');
      expect(canonicalCommandName('/check')).toBe('validate');
      expect(canonicalCommandName('/export')).toBe('archive');
    });

    it('strips leading slash from canonical commands', () => {
      expect(canonicalCommandName('/hydrate')).toBe('hydrate');
      expect(canonicalCommandName('/plan')).toBe('plan');
    });

    it('trims whitespace and strips slash in correct order', () => {
      expect(canonicalCommandName('  start  ')).toBe('hydrate');
      expect(canonicalCommandName('\tplan\t')).toBe('plan');
      // Bug fix: leading whitespace before slash
      expect(canonicalCommandName(' /start')).toBe('hydrate');
      expect(canonicalCommandName(' /approve  ')).toBe('review-decision');
    });
  });

  describe('BAD — unknowns pass through unchanged', () => {
    it('unknown command passes through', () => {
      expect(canonicalCommandName('unknown-cmd')).toBe('unknown-cmd');
    });

    it('empty string passes through', () => {
      expect(canonicalCommandName('')).toBe('');
    });

    it('preserves embedded slashes in unknown commands (kills /\\/+/ anchor mutant)', () => {
      // Kills the L87 Regex mutant that drops the leading-slash anchor.
      // Without the ^ anchor, the replace would strip ALL slashes; with anchor,
      // only the leading slash is stripped.
      expect(canonicalCommandName('foo/bar')).toBe('foo/bar');
      expect(canonicalCommandName('a/b/c')).toBe('a/b/c');
      // Leading slash IS stripped; embedded slashes are preserved.
      expect(canonicalCommandName('/foo/bar')).toBe('foo/bar');
    });
  });
});
