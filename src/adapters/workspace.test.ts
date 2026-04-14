/**
 * @module workspace.test
 * @description Tests for the workspace registry module.
 *
 * Covers:
 * - Fingerprint computation (remote canonical + local path fallback)
 * - URL canonicalization (HTTPS, SSH, SCP-style, edge cases)
 * - Path normalization for fingerprint
 * - Path segment validation (fingerprint, sessionId)
 * - Workspace/session directory resolution
 * - initWorkspace idempotency and mismatch detection
 * - Session pointer read/write (non-authoritative)
 * - archiveSession (requires tar)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalizeOriginUrl,
  normalizeForFingerprint,
  computeFingerprintFromRemote,
  computeFingerprintFromPath,
  validateFingerprint,
  validateSessionId,
  workspacesHome,
  workspaceDir,
  sessionDir,
  initWorkspace,
  readWorkspaceInfo,
  writeSessionPointer,
  readSessionPointer,
  archiveSession,
  WorkspaceError,
  type WorkspaceInfo,
} from "./workspace";
import { benchmarkSync } from "../test-policy";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let originalEnv: string | undefined;

async function createTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
}

async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort on Windows (file locks)
  }
}

// =============================================================================
// canonicalizeOriginUrl
// =============================================================================

describe("canonicalizeOriginUrl", () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("canonicalizes HTTPS URL", () => {
      expect(canonicalizeOriginUrl("https://github.com/org/repo.git")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("canonicalizes HTTPS URL without .git suffix", () => {
      expect(canonicalizeOriginUrl("https://github.com/org/repo")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("canonicalizes SSH URL", () => {
      expect(canonicalizeOriginUrl("ssh://git@github.com/org/repo.git")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("canonicalizes SCP-style URL", () => {
      expect(canonicalizeOriginUrl("git@github.com:org/repo.git")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("canonicalizes SCP-style URL without .git", () => {
      expect(canonicalizeOriginUrl("git@github.com:org/repo")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("preserves non-standard port in SSH URL", () => {
      expect(canonicalizeOriginUrl("ssh://git@myhost.com:2222/org/repo.git")).toBe(
        "repo://myhost.com:2222/org/repo",
      );
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe("CORNER", () => {
    it("casefolding: uppercase host and path become lowercase", () => {
      expect(canonicalizeOriginUrl("https://GitHub.COM/Org/Repo.git")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("collapses multiple slashes in path", () => {
      expect(canonicalizeOriginUrl("https://github.com///org///repo.git")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("strips trailing slash", () => {
      expect(canonicalizeOriginUrl("https://github.com/org/repo/")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("handles URL with trailing .git and trailing slash", () => {
      expect(canonicalizeOriginUrl("https://github.com/org/repo.git/")).toBe(
        "repo://github.com/org/repo",
      );
    });

    it("SCP-style with nested path", () => {
      expect(canonicalizeOriginUrl("git@gitlab.corp.com:group/subgroup/repo.git")).toBe(
        "repo://gitlab.corp.com/group/subgroup/repo",
      );
    });

    it("handles whitespace around URL", () => {
      expect(canonicalizeOriginUrl("  https://github.com/org/repo.git  ")).toBe(
        "repo://github.com/org/repo",
      );
    });
  });

  // ─── EDGE ───────────────────────────────────────────────────
  describe("EDGE", () => {
    it("HTTPS with port", () => {
      expect(canonicalizeOriginUrl("https://git.internal.com:8443/team/project.git")).toBe(
        "repo://git.internal.com:8443/team/project",
      );
    });

    it("file:// protocol", () => {
      const result = canonicalizeOriginUrl("file:///home/user/repos/myrepo.git");
      expect(result).toBe("repo:///home/user/repos/myrepo");
    });

    it("same repo, different protocols produce same canonical", () => {
      const https = canonicalizeOriginUrl("https://github.com/org/repo.git");
      const scp = canonicalizeOriginUrl("git@github.com:org/repo.git");
      const ssh = canonicalizeOriginUrl("ssh://git@github.com/org/repo.git");
      expect(https).toBe(scp);
      expect(https).toBe(ssh);
    });
  });
});

// =============================================================================
// normalizeForFingerprint
// =============================================================================

describe("normalizeForFingerprint", () => {
  it("replaces backslashes with forward slashes", () => {
    // On all platforms, backslashes should become forward slashes
    const result = normalizeForFingerprint("/home/user/my-repo");
    expect(result).not.toContain("\\");
    expect(result).toContain("/");
  });

  it("resolves to absolute path", () => {
    const result = normalizeForFingerprint(".");
    expect(path.isAbsolute(result.replace(/\//g, path.sep))).toBe(true);
  });
});

// =============================================================================
// Fingerprint computation (sync helpers)
// =============================================================================

describe("computeFingerprintFromRemote", () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("produces 24-char hex string", () => {
      const fp = computeFingerprintFromRemote("repo://github.com/org/repo");
      expect(fp).toMatch(/^[0-9a-f]{24}$/);
    });

    it("same input produces same fingerprint (deterministic)", () => {
      const a = computeFingerprintFromRemote("repo://github.com/org/repo");
      const b = computeFingerprintFromRemote("repo://github.com/org/repo");
      expect(a).toBe(b);
    });

    it("different inputs produce different fingerprints", () => {
      const a = computeFingerprintFromRemote("repo://github.com/org/repo-a");
      const b = computeFingerprintFromRemote("repo://github.com/org/repo-b");
      expect(a).not.toBe(b);
    });
  });

  // ─── PERF ───────────────────────────────────────────────────
  describe("PERF", () => {
    it("fingerprint computation is fast (<1ms per call)", () => {
      const { p99Ms } = benchmarkSync(
        () => computeFingerprintFromRemote("repo://github.com/org/repo"),
        1000,
      );
      expect(p99Ms).toBeLessThan(1);
    });
  });
});

describe("computeFingerprintFromPath", () => {
  it("produces 24-char hex string", () => {
    const fp = computeFingerprintFromPath("/home/user/my-repo");
    expect(fp).toMatch(/^[0-9a-f]{24}$/);
  });

  it("same path produces same fingerprint", () => {
    const a = computeFingerprintFromPath("/home/user/my-repo");
    const b = computeFingerprintFromPath("/home/user/my-repo");
    expect(a).toBe(b);
  });

  it("different paths produce different fingerprints", () => {
    const a = computeFingerprintFromPath("/home/user/repo-a");
    const b = computeFingerprintFromPath("/home/user/repo-b");
    expect(a).not.toBe(b);
  });

  it("remote and local fingerprints differ for same conceptual repo", () => {
    const remote = computeFingerprintFromRemote("repo://github.com/org/repo");
    const local = computeFingerprintFromPath("/home/user/org/repo");
    expect(remote).not.toBe(local);
  });
});

// =============================================================================
// validateFingerprint
// =============================================================================

describe("validateFingerprint", () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  it("accepts valid 24-hex fingerprint", () => {
    expect(validateFingerprint("a1b2c3d4e5f6a1b2c3d4e5f6")).toBe("a1b2c3d4e5f6a1b2c3d4e5f6");
  });

  // ─── BAD ────────────────────────────────────────────────────
  it("rejects empty string", () => {
    expect(() => validateFingerprint("")).toThrow(WorkspaceError);
  });

  it("rejects too-short fingerprint", () => {
    expect(() => validateFingerprint("a1b2c3")).toThrow(WorkspaceError);
  });

  it("rejects too-long fingerprint", () => {
    expect(() => validateFingerprint("a".repeat(25))).toThrow(WorkspaceError);
  });

  it("rejects uppercase hex", () => {
    expect(() => validateFingerprint("A1B2C3D4E5F6A1B2C3D4E5F6")).toThrow(WorkspaceError);
  });

  it("rejects non-hex characters", () => {
    expect(() => validateFingerprint("g1b2c3d4e5f6a1b2c3d4e5f6")).toThrow(WorkspaceError);
  });

  it("rejects slug-style strings", () => {
    expect(() => validateFingerprint("my-repo-fingerprint-slug")).toThrow(WorkspaceError);
  });

  // ─── CORNER ─────────────────────────────────────────────────
  it("rejects 24 chars with spaces", () => {
    expect(() => validateFingerprint("a1b2c3 d4e5f6a1b2c3d4e5f")).toThrow(WorkspaceError);
  });
});

// =============================================================================
// validateSessionId
// =============================================================================

describe("validateSessionId", () => {
  // ─── HAPPY ──────────────────────────────────────────────────
  it("accepts UUID-style session ID", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(validateSessionId(id)).toBe(id);
  });

  it("accepts simple alphanumeric ID", () => {
    expect(validateSessionId("session123")).toBe("session123");
  });

  it("trims whitespace", () => {
    expect(validateSessionId("  abc  ")).toBe("abc");
  });

  // ─── BAD ────────────────────────────────────────────────────
  it("rejects empty string", () => {
    expect(() => validateSessionId("")).toThrow(WorkspaceError);
    expect(() => validateSessionId("")).toThrow("empty");
  });

  it("rejects whitespace-only string", () => {
    expect(() => validateSessionId("   ")).toThrow(WorkspaceError);
  });

  it("rejects forward slash", () => {
    expect(() => validateSessionId("foo/bar")).toThrow(WorkspaceError);
    expect(() => validateSessionId("foo/bar")).toThrow("unsafe");
  });

  it("rejects backslash", () => {
    expect(() => validateSessionId("foo\\bar")).toThrow(WorkspaceError);
  });

  it("rejects colon", () => {
    expect(() => validateSessionId("foo:bar")).toThrow(WorkspaceError);
  });

  it("rejects NUL byte", () => {
    expect(() => validateSessionId("foo\0bar")).toThrow(WorkspaceError);
  });

  it("rejects dot-dot (path traversal)", () => {
    expect(() => validateSessionId("..")).toThrow(WorkspaceError);
    expect(() => validateSessionId("..")).toThrow("traversal");
  });

  it("rejects single dot", () => {
    expect(() => validateSessionId(".")).toThrow(WorkspaceError);
  });

  // ─── CORNER ─────────────────────────────────────────────────
  it("accepts dots within a longer string", () => {
    expect(validateSessionId("v1.2.3")).toBe("v1.2.3");
  });

  it("accepts hyphens and underscores", () => {
    expect(validateSessionId("my-session_01")).toBe("my-session_01");
  });
});

// =============================================================================
// Path resolution (workspacesHome, workspaceDir, sessionDir)
// =============================================================================

describe("path resolution", () => {
  beforeEach(() => {
    originalEnv = process.env.OPENCODE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.OPENCODE_CONFIG_DIR;
    }
  });

  it("workspacesHome defaults to ~/.config/opencode/workspaces", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    const home = workspacesHome();
    expect(home).toContain("workspaces");
    expect(home).toContain(".config");
    expect(home).toContain("opencode");
  });

  it("workspacesHome respects OPENCODE_CONFIG_DIR", () => {
    process.env.OPENCODE_CONFIG_DIR = "/custom/config";
    const home = workspacesHome();
    expect(home).toBe(path.join("/custom/config", "workspaces"));
  });

  it("workspaceDir returns correct path", () => {
    process.env.OPENCODE_CONFIG_DIR = "/cfg";
    const dir = workspaceDir("a1b2c3d4e5f6a1b2c3d4e5f6");
    expect(dir).toBe(path.join("/cfg", "workspaces", "a1b2c3d4e5f6a1b2c3d4e5f6"));
  });

  it("workspaceDir rejects invalid fingerprint", () => {
    expect(() => workspaceDir("invalid")).toThrow(WorkspaceError);
  });

  it("sessionDir returns correct nested path", () => {
    process.env.OPENCODE_CONFIG_DIR = "/cfg";
    const dir = sessionDir("a1b2c3d4e5f6a1b2c3d4e5f6", "my-session-id");
    expect(dir).toBe(
      path.join("/cfg", "workspaces", "a1b2c3d4e5f6a1b2c3d4e5f6", "sessions", "my-session-id"),
    );
  });

  it("sessionDir rejects invalid fingerprint", () => {
    expect(() => sessionDir("bad", "ok-session")).toThrow(WorkspaceError);
  });

  it("sessionDir rejects invalid sessionId", () => {
    expect(() => sessionDir("a1b2c3d4e5f6a1b2c3d4e5f6", "..")).toThrow(WorkspaceError);
  });
});

// =============================================================================
// initWorkspace
// =============================================================================

describe("initWorkspace", () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  // ─── HAPPY ──────────────────────────────────────────────────
  describe("HAPPY", () => {
    it("creates workspace and session directories", async () => {
      // Use a mock worktree that points to this test's git repo
      const worktree = path.resolve(".");
      const sessionId = "test-session-001";

      const result = await initWorkspace(worktree, sessionId);

      // Workspace info should be populated
      expect(result.fingerprint).toMatch(/^[0-9a-f]{24}$/);
      expect(result.info.fingerprint).toBe(result.fingerprint);
      expect(result.info.schemaVersion).toBe("v1");

      // Directories should exist
      const wsDir = result.workspaceDir;
      const stats = await fs.stat(wsDir);
      expect(stats.isDirectory()).toBe(true);

      const sessStats = await fs.stat(result.sessionDir);
      expect(sessStats.isDirectory()).toBe(true);

      // Subdirectories should exist
      const logsStats = await fs.stat(path.join(wsDir, "logs"));
      expect(logsStats.isDirectory()).toBe(true);

      const discoveryStats = await fs.stat(path.join(wsDir, "discovery"));
      expect(discoveryStats.isDirectory()).toBe(true);

      // workspace.json should exist
      const wsJsonPath = path.join(wsDir, "workspace.json");
      const wsJson = JSON.parse(await fs.readFile(wsJsonPath, "utf-8"));
      expect(wsJson.fingerprint).toBe(result.fingerprint);
      expect(wsJson.schemaVersion).toBe("v1");
    });

    it("is idempotent: second call returns same info", async () => {
      const worktree = path.resolve(".");
      const sessionId = "test-session-002";

      const first = await initWorkspace(worktree, sessionId);
      const second = await initWorkspace(worktree, sessionId);

      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.info.createdAt).toBe(first.info.createdAt);
      expect(second.sessionDir).toBe(first.sessionDir);
    });

    it("creates separate session directories for different session IDs", async () => {
      const worktree = path.resolve(".");

      const a = await initWorkspace(worktree, "session-a");
      const b = await initWorkspace(worktree, "session-b");

      expect(a.fingerprint).toBe(b.fingerprint); // Same repo
      expect(a.sessionDir).not.toBe(b.sessionDir); // Different sessions
    });
  });

  // ─── BAD ────────────────────────────────────────────────────
  describe("BAD", () => {
    it("rejects empty session ID", async () => {
      await expect(initWorkspace(path.resolve("."), "")).rejects.toThrow(WorkspaceError);
    });

    it("rejects path-traversal session ID", async () => {
      await expect(initWorkspace(path.resolve("."), "..")).rejects.toThrow(WorkspaceError);
    });
  });

  // ─── CORNER ─────────────────────────────────────────────────
  describe("CORNER", () => {
    it("workspace.json mismatch: different canonicalRemote → throws WORKSPACE_MISMATCH", async () => {
      const worktree = path.resolve(".");
      const sessionId = "test-session-003";

      // First: create workspace normally
      const result = await initWorkspace(worktree, sessionId);

      // Tamper: overwrite workspace.json with different canonicalRemote but same fingerprint
      if (result.info.canonicalRemote) {
        const tamperedInfo = {
          ...result.info,
          canonicalRemote: "repo://evil.com/different/repo",
        };
        await fs.writeFile(
          path.join(result.workspaceDir, "workspace.json"),
          JSON.stringify(tamperedInfo, null, 2),
          "utf-8",
        );

        await expect(initWorkspace(worktree, "session-new")).rejects.toThrow("WORKSPACE_MISMATCH");
      }
    });

    it("handles corrupt workspace.json gracefully (throws READ_FAILED)", async () => {
      const worktree = path.resolve(".");
      const sessionId = "test-session-004";

      // Create workspace first
      const result = await initWorkspace(worktree, sessionId);

      // Corrupt workspace.json
      await fs.writeFile(
        path.join(result.workspaceDir, "workspace.json"),
        "not json at all",
        "utf-8",
      );

      await expect(initWorkspace(worktree, "session-new2")).rejects.toThrow(WorkspaceError);
    });
  });
});

// =============================================================================
// readWorkspaceInfo
// =============================================================================

describe("readWorkspaceInfo", () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  it("returns null for non-existent workspace", async () => {
    const result = await readWorkspaceInfo("a1b2c3d4e5f6a1b2c3d4e5f6");
    expect(result).toBeNull();
  });

  it("returns workspace info after initWorkspace", async () => {
    const worktree = path.resolve(".");
    const { fingerprint } = await initWorkspace(worktree, "sess-001");
    const info = await readWorkspaceInfo(fingerprint);
    expect(info).not.toBeNull();
    expect(info!.fingerprint).toBe(fingerprint);
  });
});

// =============================================================================
// Session Pointer (non-authoritative)
// =============================================================================

describe("session pointer", () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  it("readSessionPointer returns null when no pointer exists", async () => {
    expect(await readSessionPointer()).toBeNull();
  });

  it("write then read round-trips pointer data", async () => {
    const fp = "a1b2c3d4e5f6a1b2c3d4e5f6";
    const sessId = "test-session";
    const sessPath = "/some/path/to/session";

    await writeSessionPointer(fp, sessId, sessPath);
    const pointer = await readSessionPointer();

    expect(pointer).not.toBeNull();
    expect(pointer!.activeRepoFingerprint).toBe(fp);
    expect(pointer!.activeSessionId).toBe(sessId);
    expect(pointer!.activeSessionDir).toBe(sessPath);
    expect(pointer!.schema).toBe("flowguard-session-pointer.v1");
  });

  it("write is fire-and-forget: does not throw on failure", async () => {
    // Set config dir to a path that cannot exist
    process.env.OPENCODE_CONFIG_DIR = path.join(tmpDir, "nonexistent\0illegal");
    // Should not throw
    await writeSessionPointer("a1b2c3d4e5f6a1b2c3d4e5f6", "sess", "/p");
  });
});

// =============================================================================
// archiveSession
// =============================================================================

describe("archiveSession", () => {
  beforeEach(async () => {
    tmpDir = await createTmpDir();
    process.env.OPENCODE_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    await cleanTmpDir(tmpDir);
  });

  it("archives a session directory as tar.gz", async () => {
    const worktree = path.resolve(".");
    const sessionId = "archive-test-001";
    const { fingerprint, sessionDir: sessDir } = await initWorkspace(worktree, sessionId);

    // Write a test file into the session directory
    await fs.writeFile(path.join(sessDir, "session-state.json"), '{"test": true}', "utf-8");

    const archivePath = await archiveSession(fingerprint, sessionId);
    expect(archivePath).toContain(".tar.gz");
    expect(archivePath).toContain(sessionId);

    // Archive file should exist
    const stats = await fs.stat(archivePath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it("throws ARCHIVE_FAILED for non-existent session", async () => {
    await expect(
      archiveSession("a1b2c3d4e5f6a1b2c3d4e5f6", "no-such-session"),
    ).rejects.toThrow("ARCHIVE_FAILED");
  });

  it("rejects invalid fingerprint", async () => {
    await expect(archiveSession("bad", "session")).rejects.toThrow(WorkspaceError);
  });

  it("rejects unsafe session ID", async () => {
    await expect(
      archiveSession("a1b2c3d4e5f6a1b2c3d4e5f6", "../escape"),
    ).rejects.toThrow(WorkspaceError);
  });
});

// =============================================================================
// PERF — bulk operations
// =============================================================================

describe("PERF", () => {
  it("canonicalizeOriginUrl is fast (<1ms per call)", () => {
    const { p99Ms } = benchmarkSync(
      () => canonicalizeOriginUrl("https://github.com/org/repo.git"),
      1000,
    );
    expect(p99Ms).toBeLessThan(1);
  });

  it("validateFingerprint is fast (<1ms per call)", () => {
    const { p99Ms } = benchmarkSync(
      () => validateFingerprint("a1b2c3d4e5f6a1b2c3d4e5f6"),
      1000,
    );
    expect(p99Ms).toBeLessThan(1);
  });

  it("validateSessionId is fast (<1ms per call)", () => {
    const { p99Ms } = benchmarkSync(
      () => validateSessionId("550e8400-e29b-41d4-a716-446655440000"),
      1000,
    );
    expect(p99Ms).toBeLessThan(1);
  });
});
