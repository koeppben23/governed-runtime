/**
 * @module integration/test-helpers
 * @description Shared test infrastructure for integration and E2E tests.
 *
 * Provides:
 * - TestToolContext: structural type matching the internal ToolContext in tools.ts
 * - createToolContext(): factory for building tool execution contexts
 * - createTestWorkspace(): tmpDir + OPENCODE_CONFIG_DIR setup with cleanup
 * - isTarAvailable(): capability gate for archive tests
 * - GIT_MOCK_DEFAULTS: default return values for git adapter mocks
 * - parseToolResult(): parse JSON tool output into typed object
 *
 * Design:
 * - TestToolContext is defined structurally (not imported from tools.ts).
 *   This keeps the production API surface unchanged.
 * - All filesystem operations use real temp directories with OPENCODE_CONFIG_DIR
 *   redirection, following the pattern established in workspace.test.ts.
 * - Git adapter functions (remoteOriginUrl, changedFiles, listRepoSignals) are
 *   expected to be mocked via vi.mock() at the test-file level. This module
 *   provides only the default values, not the mock setup itself.
 *
 * @version v1
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ─── TestToolContext ─────────────────────────────────────────────────────────

/**
 * Structural type matching the internal ToolContext in tools.ts.
 *
 * Defined here (not exported from tools.ts) to avoid widening the
 * production API surface for test purposes.
 *
 * Fields match tools.ts lines 65-73 exactly.
 */
export interface TestToolContext {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: {
    title?: string;
    metadata?: Record<string, unknown>;
  }): void;
}

/**
 * Create a ToolContext for test use.
 *
 * Provides sensible defaults for all fields. Override any field via the
 * `overrides` parameter. `worktree` and `directory` should typically be
 * set to the test's tmpDir.
 *
 * @param overrides - Partial overrides for any context field.
 */
export function createToolContext(
  overrides: Partial<TestToolContext> = {},
): TestToolContext {
  return {
    sessionID: crypto.randomUUID(),
    messageID: "msg-test-1",
    agent: "test-agent",
    directory: overrides.worktree ?? "/tmp/test-dir",
    worktree: "/tmp/test-worktree",
    abort: new AbortController().signal,
    metadata: () => {},
    ...overrides,
  };
}

// ─── Test Workspace Setup ────────────────────────────────────────────────────

/**
 * Result of createTestWorkspace().
 * Provides the tmpDir path and a cleanup function that restores env state.
 */
export interface TestWorkspace {
  /** Absolute path to the temp directory (used as OPENCODE_CONFIG_DIR). */
  tmpDir: string;
  /** Restore OPENCODE_CONFIG_DIR and remove tmpDir. */
  cleanup: () => Promise<void>;
}

/**
 * Create a temp directory and set OPENCODE_CONFIG_DIR to redirect all
 * workspace registry operations into it.
 *
 * Call `cleanup()` in afterEach to restore the original env and remove
 * the temp directory.
 *
 * Pattern follows workspace.test.ts.
 */
export async function createTestWorkspace(): Promise<TestWorkspace> {
  const originalEnv = process.env.OPENCODE_CONFIG_DIR;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fg-integ-"));
  process.env.OPENCODE_CONFIG_DIR = tmpDir;

  return {
    tmpDir,
    cleanup: async () => {
      // Restore env
      if (originalEnv !== undefined) {
        process.env.OPENCODE_CONFIG_DIR = originalEnv;
      } else {
        delete process.env.OPENCODE_CONFIG_DIR;
      }
      // Best-effort removal (Windows file locks may prevent full cleanup)
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    },
  };
}

// ─── Tar Capability Gate ─────────────────────────────────────────────────────

let tarAvailableCache: boolean | null = null;

/**
 * Check whether system `tar` is available.
 *
 * Result is cached after first call. Use with vitest's `it.skipIf()`:
 *
 *   const tarOk = await isTarAvailable();
 *   it.skipIf(!tarOk)("creates tar.gz archive", async () => { ... });
 */
export async function isTarAvailable(): Promise<boolean> {
  if (tarAvailableCache !== null) return tarAvailableCache;

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("tar", ["--version"], {
      timeout: 5_000,
      windowsHide: true,
    });
    tarAvailableCache = true;
  } catch {
    tarAvailableCache = false;
  }

  return tarAvailableCache;
}

// ─── Git Mock Defaults ───────────────────────────────────────────────────────

/**
 * Default return values for mocked git adapter functions.
 *
 * Usage in test files:
 *
 *   vi.mock("../adapters/git", async (importOriginal) => {
 *     const original = await importOriginal<typeof import("../adapters/git")>();
 *     return {
 *       ...original,
 *       remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
 *       changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
 *       listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
 *     };
 *   });
 *
 * Override per-test:
 *   vi.mocked(remoteOriginUrl).mockResolvedValueOnce(null); // repo without remote
 */
export const GIT_MOCK_DEFAULTS = {
  /** Standard HTTPS remote — produces a deterministic fingerprint. */
  remoteOriginUrl: "https://github.com/test/repo.git",
  /** Standard set of changed files for implement tool tests. */
  changedFiles: ["src/foo.ts", "src/bar.ts"],
  /**
   * Standard repo signals — triggers TypeScript profile detection.
   * Must match the RepoSignals shape returned by the real listRepoSignals().
   */
  repoSignals: {
    files: ["tsconfig.json", "package.json", "src/index.ts"],
    packageFiles: ["package.json"],
    configFiles: ["tsconfig.json"],
  },
} as const;

// ─── Tool Result Parsing ─────────────────────────────────────────────────────

/**
 * Parse a JSON tool result string into a typed object.
 *
 * Tools always return `Promise<string>` containing JSON.
 * This helper parses it and provides a typed view for assertions.
 *
 * @throws if the string is not valid JSON (indicates a tool bug).
 */
export function parseToolResult<T = Record<string, unknown>>(
  jsonStr: string,
): T {
  return JSON.parse(jsonStr) as T;
}

/**
 * Common shape of a successful tool result.
 * Tools may include additional fields beyond these.
 */
export interface ToolSuccessResult {
  phase: string;
  status: string;
  next?: string;
  _audit?: {
    transitions: Array<{
      from: string;
      to: string;
      event: string;
      at: string;
    }>;
  };
}

/**
 * Common shape of a blocked/error tool result.
 */
export interface ToolBlockedResult {
  error: true;
  code: string;
  message: string;
  recovery?: string[];
  quickFix?: string;
}

/**
 * Type guard: check if a parsed tool result is an error/blocked response.
 */
export function isBlockedResult(
  result: Record<string, unknown>,
): boolean {
  return result.error === true && typeof result.code === "string";
}
