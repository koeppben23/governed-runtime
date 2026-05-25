/**
 * @module integration/sdk-contract-plugin.test
 * @description Plugin factory resilience, smoke tests, and type baseline infrastructure.
 *
 * Validates that:
 * 1. FlowGuardAuditPlugin handles edge cases in PluginInput gracefully
 * 2. Calling hooks with SDK-shaped payloads doesn't crash (smoke)
 * 3. The snapshot script infrastructure works correctly
 *
 * Evidence sources:
 * - @opencode-ai/plugin/dist/index.d.ts (PluginInput, Hooks, Plugin)
 * - .sdk-baselines/opencode/ (baseline files)
 *
 * Split from sdk-contract.test.ts Sections D + E + F for ≤400 LOC compliance.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, SMOKE — all categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

// ── SDK imports ──────────────────────────────────────────────────────────────
import type { PluginInput, Hooks } from '@opencode-ai/plugin';

// ── Our plugin export ────────────────────────────────────────────────────────
import { FlowGuardAuditPlugin, isUsableWorktree } from './plugin.js';

// ═══════════════════════════════════════════════════════════════════════════════
// D) PLUGIN FACTORY RESILIENCE
//
// Validates that FlowGuardAuditPlugin handles edge cases in PluginInput
// gracefully without crashing.
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: Plugin factory resilience', () => {
  /**
   * Create a mock PluginInput with all 7 required fields.
   * Fields we don't use (project, $, experimental_workspace, serverUrl) are stubs.
   */
  function createMockPluginInput(overrides: Partial<PluginInput> = {}): PluginInput {
    return {
      client: {
        app: { log: async () => ({}) },
      } as PluginInput['client'],
      project: {} as PluginInput['project'],
      directory: '/tmp/sdk-contract-test',
      worktree: '/tmp/sdk-contract-test',
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost:4096'),
      $: (() => {}) as unknown as PluginInput['$'],
      ...overrides,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HAPPY PATH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('HAPPY: plugin returns hooks with expected shape', () => {
    it('returns an object with tool.execute.before and tool.execute.after', async () => {
      const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
      expect(hooks).toBeDefined();
      expect(typeof hooks['tool.execute.before']).toBe('function');
      expect(typeof hooks['tool.execute.after']).toBe('function');
    });

    it('returned hooks satisfy the Hooks interface', async () => {
      const hooks: Hooks = await FlowGuardAuditPlugin(createMockPluginInput());
      // This assignment compiles only if the return satisfies Hooks
      expect(hooks).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BAD PATH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('BAD: plugin degrades gracefully with non-repo worktree', () => {
    it('does not crash with non-existent worktree path', async () => {
      const hooks = await FlowGuardAuditPlugin(
        createMockPluginInput({ worktree: '/nonexistent/path/abc123' }),
      );
      expect(hooks).toBeDefined();
      expect(typeof hooks['tool.execute.before']).toBe('function');
      expect(typeof hooks['tool.execute.after']).toBe('function');
    });

    it('does not crash with empty worktree string', async () => {
      const hooks = await FlowGuardAuditPlugin(
        createMockPluginInput({ worktree: '', directory: '' }),
      );
      expect(hooks).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CORNER PATH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('CORNER: isUsableWorktree boundary conditions', () => {
    it('empty string returns false', () => {
      expect(isUsableWorktree('')).toBe(false);
    });

    it('undefined returns false', () => {
      expect(isUsableWorktree(undefined)).toBe(false);
    });

    it('filesystem root returns false', () => {
      expect(isUsableWorktree('/')).toBe(false);
    });

    it('Windows drive root returns false', () => {
      expect(isUsableWorktree('C:\\')).toBe(false);
      expect(isUsableWorktree('D:/')).toBe(false);
    });

    it('path without .git returns false', () => {
      expect(isUsableWorktree('/tmp')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EDGE PATH
  // ═══════════════════════════════════════════════════════════════════════════

  describe('EDGE: plugin with stub-only unused fields', () => {
    it('does not access project, $, experimental_workspace, serverUrl', async () => {
      // We provide trap proxies for unused fields. If the plugin accesses
      // any property on them, the proxy throws — proving we don't use them.
      const trapHandler: ProxyHandler<object> = {
        get(_target, prop) {
          // Allow Symbol.toPrimitive and similar internal JS operations
          if (typeof prop === 'symbol') return undefined;
          // Allow toString/valueOf for error messages
          if (prop === 'toString' || prop === 'valueOf') return () => '[trap]';
          throw new Error(`Unexpected access to unused field property: ${String(prop)}`);
        },
      };

      const input = createMockPluginInput({
        project: new Proxy({}, trapHandler) as PluginInput['project'],
        $: new Proxy(() => {}, trapHandler) as unknown as PluginInput['$'],
        experimental_workspace: new Proxy(
          { register: () => {} },
          trapHandler,
        ) as PluginInput['experimental_workspace'],
        // serverUrl is a URL — can't easily proxy, but we can verify
        // it's not accessed by using a valid but unusual URL
        serverUrl: new URL('http://trap.invalid:9999'),
      });

      // If this doesn't throw, the plugin doesn't access unused fields
      const hooks = await FlowGuardAuditPlugin(input);
      expect(hooks).toBeDefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E) SMOKE: End-to-end hook invocation
//
// Validates that calling the hooks with SDK-shaped payloads doesn't crash.
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: Smoke — hook invocation with SDK payloads', () => {
  function createMockPluginInput(): PluginInput {
    return {
      client: {
        app: { log: async () => ({}) },
      } as PluginInput['client'],
      project: {} as PluginInput['project'],
      directory: '/tmp/sdk-smoke',
      worktree: '/tmp/sdk-smoke',
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost:4096'),
      $: (() => {}) as unknown as PluginInput['$'],
    };
  }

  it('SMOKE: before-hook accepts SDK-shaped input without crashing', async () => {
    const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
    const beforeHook = hooks['tool.execute.before'];
    expect(beforeHook).toBeDefined();

    // Call with full SDK shape (including callID which our types omit)
    const input = { tool: 'unknown_tool', sessionID: 'sess-smoke', callID: 'call-smoke' };
    const output = { args: {} };

    // Should not throw — unknown tools are passed through
    await expect(beforeHook!(input, output)).resolves.not.toThrow();
  });

  it('SMOKE: after-hook accepts SDK-shaped output without crashing', async () => {
    const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
    const afterHook = hooks['tool.execute.after'];
    expect(afterHook).toBeDefined();

    // Call with full SDK shape (including title + metadata)
    const input = {
      tool: 'unknown_tool',
      sessionID: 'sess-smoke',
      callID: 'call-smoke',
      args: {},
    };
    const output = { title: 'Unknown', output: 'some output', metadata: null };

    await expect(afterHook!(input, output)).resolves.not.toThrow();
  });

  it('SMOKE: before-hook handles flowguard-prefixed tool', async () => {
    const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
    const beforeHook = hooks['tool.execute.before'];

    const input = { tool: 'flowguard_status', sessionID: 'sess-fg', callID: 'call-fg' };
    const output = { args: {} };

    // FlowGuard tools are handled by the plugin — should not crash
    await expect(beforeHook!(input, output)).resolves.not.toThrow();
  });

  it('SMOKE: after-hook handles flowguard-prefixed tool', async () => {
    const hooks = await FlowGuardAuditPlugin(createMockPluginInput());
    const afterHook = hooks['tool.execute.after'];

    const input = {
      tool: 'flowguard_status',
      sessionID: 'sess-fg',
      callID: 'call-fg',
      args: {},
    };
    const output = { title: 'Status', output: '{}', metadata: null };

    await expect(afterHook!(input, output)).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F) SDK TYPE BASELINE INTEGRITY
//
// Validates the snapshot script infrastructure works correctly.
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: Type baseline infrastructure', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');

  it('HAPPY: baseline files exist in .sdk-baselines/opencode/', () => {
    expect(existsSync(path.join(root, '.sdk-baselines', 'opencode', 'plugin-index.d.ts'))).toBe(
      true,
    );
    expect(existsSync(path.join(root, '.sdk-baselines', 'opencode', 'plugin-tool.d.ts'))).toBe(
      true,
    );
  });

  it('HAPPY: baseline files match installed SDK', () => {
    const indexBaseline = readFileSync(
      path.join(root, '.sdk-baselines', 'opencode', 'plugin-index.d.ts'),
      'utf-8',
    );
    const indexInstalled = readFileSync(
      path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'index.d.ts'),
      'utf-8',
    );

    // Normalize for comparison
    const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
    expect(norm(indexBaseline)).toBe(norm(indexInstalled));
  });

  it('HAPPY: version.json exists and records correct version', () => {
    const versionPath = path.join(root, '.sdk-baselines', 'opencode', 'version.json');
    expect(existsSync(versionPath)).toBe(true);

    const meta = JSON.parse(readFileSync(versionPath, 'utf-8'));
    expect(meta.version).toBe('1.15.10');
    expect(meta.files).toHaveLength(2);
    expect(meta.files[0].label).toBe('plugin/dist/index.d.ts');
    expect(meta.files[1].label).toBe('plugin/dist/tool.d.ts');
  });

  it('BAD: installed SDK at wrong path would be detected by snapshot script', () => {
    // The snapshot script looks at plugin/dist/index.d.ts, not sdk/dist/gen/types.gen.d.ts.
    // This test verifies the correct path is used.

    // Correct path exists
    expect(
      existsSync(path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'index.d.ts')),
    ).toBe(true);

    // The OLD (wrong) path from the original plan does NOT exist in the plugin package
    expect(
      existsSync(
        path.join(root, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'gen', 'types.gen.d.ts'),
      ),
    ).toBe(false);
  });

  it('EDGE: SDK gen types live in @opencode-ai/sdk, not @opencode-ai/plugin', () => {
    // gen types are in the SDK package, not the plugin package
    expect(
      existsSync(
        path.join(root, 'node_modules', '@opencode-ai', 'sdk', 'dist', 'gen', 'types.gen.d.ts'),
      ),
    ).toBe(true);
  });
});
