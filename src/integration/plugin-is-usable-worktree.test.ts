/**
 * @module integration/plugin-is-usable-worktree.test
 * @description Fail-closed worktree validation for FlowGuardAuditPlugin.
 */
import { describe, it, expect } from 'vitest';
import { isUsableWorktree } from './plugin.js';

// ─── isUsableWorktree (fail-closed worktree validation) ─────────────────────

describe('isUsableWorktree', () => {
  it('rejects undefined and empty strings', () => {
    expect(isUsableWorktree(undefined)).toBe(false);
    expect(isUsableWorktree('')).toBe(false);
  });

  it('rejects the filesystem root', () => {
    expect(isUsableWorktree('/')).toBe(false);
  });

  it('rejects a path that does not exist', () => {
    expect(isUsableWorktree('/this/path/does/not/exist/anywhere')).toBe(false);
  });
});
