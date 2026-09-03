/**
 * @module architecture/workspace-factory-parity
 * @description Guards the production composition boundary of `createWorkspace()`.
 *
 * `createWorkspace()` re-exposes `PluginWorkspaceImpl` as a set of delegating
 * closures, and that object — not the class — is what `plugin.ts` hands to the
 * orchestrator. A closure that forwards fewer arguments than the method it
 * delegates to is still assignable: TypeScript accepts a function with FEWER
 * parameters where more are expected, and JavaScript discards the surplus
 * arguments at the call site. The result is a silent capability loss between a
 * correct interface and a correct implementation, with no compile error and no
 * failing unit test of the implementation.
 *
 * That is not hypothetical: `updateReviewAssurance` shipped as `(sd, u) => ...`
 * while the contract and implementation both took a third semantic-intent
 * argument, so every semantic audit intent raised by the review pipeline was
 * dropped in production while the implementation's own tests stayed green.
 *
 * This guard compares delegation arity against the implementation method
 * instead of any single behaviour, so the whole class of defect is caught for
 * every current and future member.
 */

import { describe, it, expect } from 'vitest';
import { createWorkspace, PluginWorkspaceImpl } from '../../integration/plugin-workspace.js';
import type { WorkspaceDeps } from '../../integration/plugin-workspace.js';

describe('createWorkspace delegation parity', () => {
  it('forwards every declared parameter of each delegated method', () => {
    const workspace = createWorkspace({ auditWorktree: undefined } as WorkspaceDeps);

    const mismatches: string[] = [];
    for (const key of Object.keys(workspace)) {
      // Accessors are value projections, not delegations — reading them would
      // invoke the getter rather than describe a forwarding contract.
      const descriptor = Object.getOwnPropertyDescriptor(workspace, key);
      if (!descriptor || typeof descriptor.value !== 'function') continue;

      const implMethod = (PluginWorkspaceImpl.prototype as unknown as Record<string, unknown>)[key];
      if (typeof implMethod !== 'function') continue;

      const delegated = (descriptor.value as (...args: unknown[]) => unknown).length;
      const declared = (implMethod as (...args: unknown[]) => unknown).length;
      if (delegated !== declared) {
        mismatches.push(
          `${key}: factory forwards ${delegated}, implementation declares ${declared}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('delegates every function member of the implementation surface', () => {
    // A member missing from the factory cannot be caught by the arity check
    // above, but is the same class of composition gap.
    const workspace = createWorkspace({ auditWorktree: undefined } as WorkspaceDeps);
    const exposed = new Set(Object.keys(workspace));

    const missing = Object.getOwnPropertyNames(PluginWorkspaceImpl.prototype).filter((key) => {
      if (key === 'constructor') return false;
      const descriptor = Object.getOwnPropertyDescriptor(PluginWorkspaceImpl.prototype, key);
      if (!descriptor || typeof descriptor.value !== 'function') return false;
      return !exposed.has(key);
    });

    expect(missing).toEqual([]);
  });
});
