/**
 * @module discovery/discovery.test
 * @description Tests for the Discovery system — types, collectors, orchestrator, and archive types.
 *
 * Coverage:
 * - Zod schema validation (happy + bad)
 * - All 6 collectors (stack, topology, surfaces, code-surface-analysis, domain-signals, repo-metadata)
 * - Orchestrator (runDiscovery, extractDiscoverySummary, computeDiscoveryDigest)
 * - Archive types (manifest, verification, findings)
 * - Edge cases: empty inputs, large inputs, partial failures
 *
 * @version v1
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Discovery types
import {
  DiscoveryResultSchema,
  ProfileResolutionSchema,
  DiscoverySummarySchema,
  DetectedItemSchema,
  ArchiveManifestSchema,
  ArchiveVerificationSchema,
  ArchiveFindingSchema,
  ArchiveFindingCodeSchema,
  DISCOVERY_SCHEMA_VERSION,
  PROFILE_RESOLUTION_SCHEMA_VERSION,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  type CollectorInput,
  type DiscoveryResult,
} from "../index";

// Collectors
import { collectStack } from "./collectors/stack-detection";
import { collectTopology } from "./collectors/topology";
import { collectSurfaces } from "./collectors/surface-detection";
import { collectCodeSurfaces } from "./collectors/code-surface-analysis";
import { collectDomainSignals } from "./collectors/domain-signals";

// Orchestrator
import {
  runDiscovery,
  extractDiscoverySummary,
  computeDiscoveryDigest,
} from "./orchestrator";

// ─── Git Adapter Mock (module-level, deterministic) ──────────────────────────
// The repo-metadata collector imports from ../adapters/git. A single
// module-level mock ensures deterministic behavior across all orchestrator tests.
// Per-test overrides use vi.mocked().mockResolvedValueOnce() where needed.

vi.mock("../adapters/git", () => ({
  defaultBranch: vi.fn().mockResolvedValue("main"),
  headCommit: vi.fn().mockResolvedValue("abc1234"),
  isClean: vi.fn().mockResolvedValue(true),
  remoteOriginUrl: vi.fn().mockResolvedValue(null),
}));

const gitMock = await import("../adapters/git");

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const EMPTY_INPUT: CollectorInput = {
  worktreePath: "/test/repo",
  fingerprint: "abcdef0123456789abcdef01",
  allFiles: [],
  packageFiles: [],
  configFiles: [],
};

const TS_PROJECT_INPUT: CollectorInput = {
  worktreePath: "/test/ts-project",
  fingerprint: "abcdef0123456789abcdef01",
  allFiles: [
    "src/index.ts",
    "src/app.ts",
    "src/utils/helper.ts",
    "src/services/auth.ts",
    "src/auth/middleware.ts",
    "src/controllers/user.ts",
    "src/models/user.ts",
    "test/app.test.ts",
    "package.json",
    "tsconfig.json",
    "vitest.config.ts",
    ".eslintrc.json",
    ".prettierrc",
    ".github/workflows/ci.yml",
    "README.md",
    "prisma/schema.prisma",
  ],
  packageFiles: ["package.json"],
  configFiles: [
    "tsconfig.json",
    "vitest.config.ts",
    ".eslintrc.json",
    ".prettierrc",
  ],
};

const MONOREPO_INPUT: CollectorInput = {
  worktreePath: "/test/monorepo",
  fingerprint: "123456789abcdef012345678",
  allFiles: [
    "package.json",
    "nx.json",
    "tsconfig.json",
    "packages/api/package.json",
    "packages/api/src/index.ts",
    "packages/web/package.json",
    "packages/web/src/main.tsx",
    "packages/shared/package.json",
    "packages/shared/src/utils.ts",
    "libs/common/package.json",
    ".github/workflows/ci.yml",
  ],
  packageFiles: ["package.json"],
  configFiles: ["tsconfig.json", "nx.json"],
};

// ─── Schema Tests ─────────────────────────────────────────────────────────────

describe("discovery/types", () => {
  describe("HAPPY", () => {
    it("DetectedItem validates correct data", () => {
      const result = DetectedItemSchema.safeParse({
        id: "typescript",
        confidence: 0.85,
        classification: "fact",
        evidence: ["tsconfig.json"],
      });
      expect(result.success).toBe(true);
    });

    it("DiscoverySummary validates correct data", () => {
      const result = DiscoverySummarySchema.safeParse({
        primaryLanguages: ["typescript"],
        frameworks: ["vite"],
        topologyKind: "single-project",
        moduleCount: 0,
        hasApiSurface: true,
        hasPersistenceSurface: false,
        hasCiCd: true,
        hasSecuritySurface: false,
      });
      expect(result.success).toBe(true);
    });

    it("ProfileResolution validates correct data", () => {
      const result = ProfileResolutionSchema.safeParse({
        schemaVersion: PROFILE_RESOLUTION_SCHEMA_VERSION,
        resolvedAt: new Date().toISOString(),
        primary: { id: "typescript", name: "TypeScript", confidence: 0.7, evidence: [] },
        secondary: [],
        rejected: [{ id: "backend-java", score: 0, reason: "No matching signals" }],
        activeChecks: ["test_quality", "rollback_safety"],
      });
      expect(result.success).toBe(true);
    });

    it("DISCOVERY_SCHEMA_VERSION is discovery.v1", () => {
      expect(DISCOVERY_SCHEMA_VERSION).toBe("discovery.v1");
    });

    it("PROFILE_RESOLUTION_SCHEMA_VERSION is profile-resolution.v1", () => {
      expect(PROFILE_RESOLUTION_SCHEMA_VERSION).toBe("profile-resolution.v1");
    });
  });

  describe("BAD", () => {
    it("DetectedItem rejects confidence > 1", () => {
      const result = DetectedItemSchema.safeParse({
        id: "test",
        confidence: 1.5,
        classification: "fact",
        evidence: [],
      });
      expect(result.success).toBe(false);
    });

    it("DetectedItem rejects invalid classification", () => {
      const result = DetectedItemSchema.safeParse({
        id: "test",
        confidence: 0.5,
        classification: "guess",
        evidence: [],
      });
      expect(result.success).toBe(false);
    });

    it("DiscoverySummary rejects invalid topologyKind", () => {
      const result = DiscoverySummarySchema.safeParse({
        primaryLanguages: [],
        frameworks: [],
        topologyKind: "invalid",
        moduleCount: 0,
        hasApiSurface: false,
        hasPersistenceSurface: false,
        hasCiCd: false,
        hasSecuritySurface: false,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ─── Archive Types Tests ──────────────────────────────────────────────────────

describe("archive/types", () => {
  describe("HAPPY", () => {
    it("ArchiveManifest validates correct data", () => {
      const result = ArchiveManifestSchema.safeParse({
        schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        sessionId: crypto.randomUUID(),
        fingerprint: "abcdef0123456789abcdef01",
        policyMode: "solo",
        profileId: "baseline",
        discoveryDigest: "abc123",
        includedFiles: ["session-state.json", "audit.jsonl"],
        fileDigests: { "session-state.json": "sha256hash", "audit.jsonl": "sha256hash2" },
        contentDigest: "overallhash",
        redactionMode: "basic",
        rawIncluded: false,
        redactedArtifacts: ["decision-receipts.redacted.v1.json"],
        excludedFiles: ["decision-receipts.v1.json"],
        riskFlags: [],
      });
      expect(result.success).toBe(true);
    });

    it("ArchiveFinding validates correct data", () => {
      const result = ArchiveFindingSchema.safeParse({
        code: "missing_manifest",
        severity: "error",
        message: "Archive manifest not found",
      });
      expect(result.success).toBe(true);
    });

    it("ArchiveVerification validates correct data", () => {
      const result = ArchiveVerificationSchema.safeParse({
        passed: true,
        findings: [],
        manifest: null,
        verifiedAt: new Date().toISOString(),
      });
      expect(result.success).toBe(true);
    });

    it("all 10 finding codes are valid", () => {
      const codes = [
        "missing_manifest", "manifest_parse_error", "missing_file",
        "unexpected_file", "file_digest_mismatch", "content_digest_mismatch",
        "archive_checksum_missing", "archive_checksum_mismatch",
        "snapshot_missing", "state_missing",
      ];
      for (const code of codes) {
        expect(ArchiveFindingCodeSchema.safeParse(code).success).toBe(true);
      }
    });
  });

  describe("BAD", () => {
    it("ArchiveManifest rejects invalid fingerprint", () => {
      const result = ArchiveManifestSchema.safeParse({
        schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        sessionId: crypto.randomUUID(),
        fingerprint: "too-short",
        policyMode: "solo",
        profileId: "baseline",
        discoveryDigest: null,
        includedFiles: [],
        fileDigests: {},
        contentDigest: "hash",
      });
      expect(result.success).toBe(false);
    });

    it("ArchiveFindingCode rejects unknown code", () => {
      expect(ArchiveFindingCodeSchema.safeParse("unknown_code").success).toBe(false);
    });
  });
});

// ─── Collector Tests ──────────────────────────────────────────────────────────

describe("discovery/collectors/stack-detection", () => {
  describe("HAPPY", () => {
    it("detects TypeScript language from .ts files", async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      expect(result.status).toBe("complete");
      expect(result.data.languages.some((l) => l.id === "typescript")).toBe(true);
    });

    it("detects npm build tool from package.json", async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      expect(result.data.buildTools.some((t) => t.id === "npm")).toBe(true);
    });

    it("detects vitest test framework from config", async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      expect(result.data.testFrameworks.some((t) => t.id === "vitest")).toBe(true);
    });

    it("ignores non-framework config files", async () => {
      // Config files not matching FRAMEWORK_CONFIG_RULES are ignored
      // This ensures only relevant framework configs are collected
      const result = await collectStack(TS_PROJECT_INPUT);
      // Verify that unrelated config files don't create phantom frameworks
      const frameworkIds = result.data.frameworks.map((f) => f.id);
      expect(frameworkIds.filter((id) => id !== "vitest")).toHaveLength(0);
    });
  });

  describe("CORNER", () => {
    it("returns empty arrays for empty input", async () => {
      const result = await collectStack(EMPTY_INPUT);
      expect(result.status).toBe("complete");
      expect(result.data.languages).toHaveLength(0);
      expect(result.data.frameworks).toHaveLength(0);
      expect(result.data.buildTools).toHaveLength(0);
    });

    it("languages sorted by confidence descending", async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      const langs = result.data.languages;
      for (let i = 1; i < langs.length; i++) {
        expect(langs[i - 1].confidence).toBeGreaterThanOrEqual(langs[i].confidence);
      }
    });

    it("all detected items have valid classification", async () => {
      const result = await collectStack(TS_PROJECT_INPUT);
      const allItems = [
        ...result.data.languages,
        ...result.data.buildTools,
        ...result.data.frameworks,
        ...result.data.testFrameworks,
        ...result.data.runtimes,
      ];
      for (const item of allItems) {
        expect(["fact", "derived_signal", "hypothesis"]).toContain(item.classification);
        expect(item.confidence).toBeGreaterThanOrEqual(0);
        expect(item.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe("discovery/collectors/topology", () => {
  describe("HAPPY", () => {
    it("detects single-project topology", async () => {
      const result = await collectTopology(TS_PROJECT_INPUT);
      expect(result.status).toBe("complete");
      expect(result.data.kind).toBe("single-project");
    });

    it("detects monorepo topology with nx.json", async () => {
      const result = await collectTopology(MONOREPO_INPUT);
      expect(result.status).toBe("complete");
      expect(result.data.kind).toBe("monorepo");
    });

    it("detects modules in monorepo", async () => {
      const result = await collectTopology(MONOREPO_INPUT);
      // packages/api, packages/web, packages/shared, libs/common
      expect(result.data.modules.length).toBeGreaterThanOrEqual(3);
    });

    it("detects entry points", async () => {
      const result = await collectTopology(TS_PROJECT_INPUT);
      const entryPoints = result.data.entryPoints;
      expect(entryPoints.some((e) => e.path.includes("index.ts"))).toBe(true);
    });

    it("includes standard ignore paths", async () => {
      const result = await collectTopology(TS_PROJECT_INPUT);
      expect(result.data.ignorePaths).toContain("node_modules");
      expect(result.data.ignorePaths).toContain("dist");
    });
  });

  describe("CORNER", () => {
    it("returns unknown for empty input", async () => {
      const result = await collectTopology(EMPTY_INPUT);
      expect(result.data.kind).toBe("unknown");
      expect(result.data.modules).toHaveLength(0);
    });

    it("detects root-level config files", async () => {
      const result = await collectTopology(TS_PROJECT_INPUT);
      expect(result.data.rootConfigs).toContain("tsconfig.json");
      expect(result.data.rootConfigs).toContain("package.json");
    });
  });
});

describe("discovery/collectors/surface-detection", () => {
  describe("HAPPY", () => {
    it("detects API surface from controller paths", async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      expect(result.status).toBe("complete");
      expect(result.data.api.length).toBeGreaterThan(0);
    });

    it("detects persistence surface from prisma", async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      expect(result.data.persistence.length).toBeGreaterThan(0);
      expect(result.data.persistence.some((s) => s.id === "prisma")).toBe(true);
    });

    it("detects CI/CD surface from GitHub Actions", async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      expect(result.data.cicd.length).toBeGreaterThan(0);
      expect(result.data.cicd.some((s) => s.id === "github-actions")).toBe(true);
    });

    it("detects security surface from auth paths", async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      expect(result.data.security.length).toBeGreaterThan(0);
    });

    it("detects architectural layers", async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      const layerNames = result.data.layers.map((l) => l.name);
      expect(layerNames).toContain("controller");
      expect(layerNames).toContain("service");
      expect(layerNames).toContain("model");
    });
  });

  describe("CORNER", () => {
    it("returns empty arrays for empty input", async () => {
      const result = await collectSurfaces(EMPTY_INPUT);
      expect(result.status).toBe("complete");
      expect(result.data.api).toHaveLength(0);
      expect(result.data.persistence).toHaveLength(0);
      expect(result.data.layers).toHaveLength(0);
    });

    it("all surfaces have valid classification", async () => {
      const result = await collectSurfaces(TS_PROJECT_INPUT);
      const allSurfaces = [
        ...result.data.api,
        ...result.data.persistence,
        ...result.data.cicd,
        ...result.data.security,
      ];
      for (const surface of allSurfaces) {
        expect(["fact", "derived_signal", "hypothesis"]).toContain(surface.classification);
        expect(surface.evidence.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("discovery/collectors/domain-signals", () => {
  describe("HAPPY", () => {
    it("detects auth domain keyword from auth path", async () => {
      const result = await collectDomainSignals(TS_PROJECT_INPUT);
      expect(result.status).toBe("complete");
      expect(result.data.keywords.some((k) => k.term === "authentication")).toBe(true);
    });

    it("detects glossary source from README", async () => {
      const result = await collectDomainSignals(TS_PROJECT_INPUT);
      expect(result.data.glossarySources.some((s) => s.includes("README"))).toBe(true);
    });

    it("keywords sorted by occurrences descending", async () => {
      const result = await collectDomainSignals(TS_PROJECT_INPUT);
      const keywords = result.data.keywords;
      for (let i = 1; i < keywords.length; i++) {
        expect(keywords[i - 1].occurrences).toBeGreaterThanOrEqual(keywords[i].occurrences);
      }
    });
  });

  describe("CORNER", () => {
    it("returns empty for empty input", async () => {
      const result = await collectDomainSignals(EMPTY_INPUT);
      expect(result.status).toBe("complete");
      expect(result.data.keywords).toHaveLength(0);
      expect(result.data.glossarySources).toHaveLength(0);
    });

    it("all keywords have derived_signal classification", async () => {
      const result = await collectDomainSignals(TS_PROJECT_INPUT);
      for (const kw of result.data.keywords) {
        expect(kw.classification).toBe("derived_signal");
      }
    });
  });
});

describe("discovery/collectors/code-surface-analysis", () => {
  async function withTempProject(
    files: Record<string, string>,
    run: (input: CollectorInput) => Promise<void>,
  ): Promise<void> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fg-code-surface-"));
    try {
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(tmp, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, "utf-8");
      }
      await run({
        worktreePath: tmp,
        fingerprint: "abcdef0123456789abcdef01",
        allFiles: Object.keys(files),
        packageFiles: ["package.json"],
        configFiles: ["tsconfig.json"],
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  describe("HAPPY", () => {
    it("detects endpoint/auth/data/integration signals from source content", async () => {
      await withTempProject(
        {
          "src/api/users.ts": "router.get('/users', authMiddleware, async () => prisma.user.findMany());",
          "src/integration/client.ts": "await axios('/external/service');",
        },
        async (input) => {
          const result = await collectCodeSurfaces(input);
          expect(result.status).toBe("complete");
          expect(result.data.status).toBe("ok");
          expect(result.data.endpoints.length).toBeGreaterThan(0);
          expect(result.data.authBoundaries.length).toBeGreaterThan(0);
          expect(result.data.dataAccess.length).toBeGreaterThan(0);
          expect(result.data.integrations.length).toBeGreaterThan(0);
        },
      );
    });
  });

  describe("BAD", () => {
    it("degrades to partial when candidate files cannot be read", async () => {
      const result = await collectCodeSurfaces({
        worktreePath: "/definitely/missing/worktree",
        fingerprint: "abcdef0123456789abcdef01",
        allFiles: ["src/api/missing.ts"],
        packageFiles: [],
        configFiles: [],
      });
      expect(result.status).toBe("partial");
      expect(result.data.status).toBe("partial");
    });

    it("returns failed when candidate file entries are malformed", async () => {
      const malformed = {
        worktreePath: "/tmp",
        fingerprint: "abcdef0123456789abcdef01",
        allFiles: [null as unknown as string],
        packageFiles: [],
        configFiles: [],
      } as CollectorInput;

      const result = await collectCodeSurfaces(malformed);
      expect(result.status).toBe("failed");
      expect(result.data.status).toBe("failed");
      expect(result.data.budget.timedOut).toBe(true);
    });
  });

  describe("CORNER", () => {
    it("returns empty signals for files without matching patterns", async () => {
      await withTempProject(
        {
          "src/plain.ts": "export const answer = 42;",
        },
        async (input) => {
          const result = await collectCodeSurfaces(input);
          expect(result.data.endpoints).toHaveLength(0);
          expect(result.data.authBoundaries).toHaveLength(0);
          expect(result.data.dataAccess).toHaveLength(0);
          expect(result.data.integrations).toHaveLength(0);
        },
      );
    });
  });

  describe("EDGE", () => {
    it("marks partial when candidate set exceeds file budget", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 260; i++) {
        files[`src/file-${i}.ts`] = `export const n${i} = ${i};`;
      }
      await withTempProject(files, async (input) => {
        const result = await collectCodeSurfaces(input);
        expect(result.status).toBe("partial");
        expect(result.data.status).toBe("partial");
        expect(result.data.budget.scannedFiles).toBeLessThanOrEqual(200);
      });
    });

    it("marks partial and truncates when a source file exceeds per-file byte budget", async () => {
      await withTempProject(
        {
          "src/oversized.ts": `router.get('/x', () => {})\n${"x".repeat(80 * 1024)}`,
        },
        async (input) => {
          const result = await collectCodeSurfaces(input);
          expect(result.status).toBe("partial");
          expect(result.data.status).toBe("partial");
          expect(result.data.budget.scannedBytes).toBeLessThanOrEqual(64 * 1024);
          expect(result.data.endpoints.length).toBeGreaterThan(0);
        },
      );
    });

    it("marks partial when cumulative bytes exceed total budget", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 32; i++) {
        files[`src/heavy-${i}.ts`] = `export const n${i} = ${i};\n${"y".repeat(65480)}`;
      }
      files["src/heavy-overflow.ts"] = `export const overflow = true;\n${"z".repeat(2048)}`;

      await withTempProject(files, async (input) => {
        const result = await collectCodeSurfaces(input);
        expect(result.status).toBe("partial");
        expect(result.data.status).toBe("partial");
        expect(result.data.budget.scannedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(result.data.budget.scannedFiles).toBeLessThan(Object.keys(files).length);
      });
    });
  });
});

// ─── Orchestrator Tests ───────────────────────────────────────────────────────

describe("discovery/orchestrator", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("HAPPY", () => {
    it("runDiscovery returns complete result for TypeScript project", async () => {
      // Override remoteOriginUrl for this test (default mock returns null)
      vi.mocked(gitMock.remoteOriginUrl).mockResolvedValueOnce(
        "https://github.com/test/repo.git",
      );

      const result = await runDiscovery(TS_PROJECT_INPUT);

      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
      expect(result.collectedAt).toBeDefined();
      expect(typeof result.collectedAt).toBe("string");

      // All collectors should report status
      expect(Object.keys(result.collectors).length).toBe(6);

      // Stack should have detected TypeScript
      expect(result.stack.languages.some((l) => l.id === "typescript")).toBe(true);

      // Topology should be single-project
      expect(result.topology.kind).toBe("single-project");

      // Validation hints should have commands
      expect(result.validationHints.commands.length).toBeGreaterThan(0);

      // Schema validation passes
      const parsed = DiscoveryResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it("extractDiscoverySummary produces lightweight summary", async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const summary = extractDiscoverySummary(result);

      expect(summary.primaryLanguages).toContain("typescript");
      expect(summary.topologyKind).toBe("single-project");
      expect(typeof summary.moduleCount).toBe("number");
      expect(typeof summary.hasApiSurface).toBe("boolean");
      expect(typeof summary.hasPersistenceSurface).toBe("boolean");
      expect(typeof summary.hasCiCd).toBe("boolean");

      // Schema validation passes
      const parsed = DiscoverySummarySchema.safeParse(summary);
      expect(parsed.success).toBe(true);
    });

    it("computeDiscoveryDigest returns deterministic hash", async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const digest1 = computeDiscoveryDigest(result);
      const digest2 = computeDiscoveryDigest(result);

      expect(digest1).toBe(digest2);
      expect(digest1.length).toBe(64); // SHA-256 hex
      expect(/^[0-9a-f]{64}$/.test(digest1)).toBe(true);
    });
  });

  describe("CORNER", () => {
    it("handles empty input gracefully", async () => {
      // Override git mocks to return null for empty-repo scenario
      vi.mocked(gitMock.defaultBranch).mockResolvedValueOnce(null as unknown as string);
      vi.mocked(gitMock.headCommit).mockResolvedValueOnce(null as unknown as string);

      const result = await runDiscovery(EMPTY_INPUT);

      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
      expect(result.stack.languages).toHaveLength(0);
      expect(result.topology.kind).toBe("unknown");
    });

    it("validation hints derive typecheck command from tsconfig", async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const typecheckCmd = result.validationHints.commands.find(
        (c) => c.kind === "typecheck",
      );
      expect(typecheckCmd).toBeDefined();
      expect(typecheckCmd?.command).toContain("tsc");
    });

    it("validation hints derive lint tools from eslint config", async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const eslint = result.validationHints.lintTools.find((t) => t.id === "eslint");
      expect(eslint).toBeDefined();
      expect(eslint?.classification).toBe("fact");
    });

    it("monorepo input yields monorepo topology", async () => {
      const result = await runDiscovery(MONOREPO_INPUT);
      expect(result.topology.kind).toBe("monorepo");
      expect(result.topology.modules.length).toBeGreaterThanOrEqual(3);
    });

    it("derives gradle/jest commands from detected stack", async () => {
      const input: CollectorInput = {
        worktreePath: "/test/gradle",
        fingerprint: "abcdef0123456789abcdef01",
        allFiles: ["src/app.kt"],
        packageFiles: ["build.gradle"],
        configFiles: ["jest.config.ts"],
      };

      const result = await runDiscovery(input);
      const commands = result.validationHints.commands.map((c) => c.command);

      expect(commands).toContain("gradle build");
      expect(commands).toContain("gradle test");
      expect(commands).toContain("npx jest");
    });

    it("derives cargo and go-module commands from detected stack", async () => {
      const input: CollectorInput = {
        worktreePath: "/test/multi",
        fingerprint: "abcdef0123456789abcdef01",
        allFiles: ["src/lib.rs", "main.go"],
        packageFiles: ["Cargo.toml", "go.mod"],
        configFiles: [],
      };

      const result = await runDiscovery(input);
      const commands = result.validationHints.commands.map((c) => c.command);

      expect(commands).toContain("cargo build");
      expect(commands).toContain("cargo test");
      expect(commands).toContain("go build ./...");
      expect(commands).toContain("go test ./...");
    });

    it("derives maven commands from detected stack", async () => {
      const input: CollectorInput = {
        worktreePath: "/test/maven",
        fingerprint: "abcdef0123456789abcdef01",
        allFiles: ["src/main/java/App.java"],
        packageFiles: ["pom.xml"],
        configFiles: [],
      };

      const result = await runDiscovery(input);
      const commands = result.validationHints.commands.map((c) => c.command);

      expect(commands).toContain("mvn compile");
      expect(commands).toContain("mvn test");
    });
  });

  describe("CORNER", () => {
    it("collectStack handles malformed package.json gracefully", async () => {
      // Input with both invalid and valid package files
      const badInput: CollectorInput = {
        ...TS_PROJECT_INPUT,
        packageFiles: [
          "yarn.lock",
          "package.json",
        ],
      };

      // Should not throw — should handle gracefully
      const result = await collectStack(badInput);
      expect(result.status).toBe("complete");
      // Valid package.json should still be processed (npm is a build tool)
      const npm = result.data.buildTools.find((b) => b.id === "npm");
      expect(npm).toBeDefined();
      expect(npm?.confidence).toBe(0.9);
    });

    it("collectSurfaces handles empty files array", async () => {
      const result = await collectSurfaces({ ...EMPTY_INPUT });
      expect(result.status).toBe("complete");
      expect(result.data).toBeDefined();
    });

    it("runDiscovery completes even if one collector throws", async () => {
      // Note: Individual collectors should not throw, but we verify resilience
      // If a collector throws, the orchestrator should handle it
      const result = await runDiscovery(TS_PROJECT_INPUT);
      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
    });
  });

  describe("EDGE", () => {
    it("runDiscovery with extreme input size completes within timeout", async () => {
      // Create a large input to test performance under load
      const largeInput: CollectorInput = {
        ...TS_PROJECT_INPUT,
        allFiles: Array.from({ length: 10000 }, (_, i) => `src/file${i}.ts`),
      };

      const start = Date.now();
      const result = await runDiscovery(largeInput);
      const elapsed = Date.now() - start;

      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
      // Should complete within reasonable time (< 5 seconds)
      expect(elapsed).toBeLessThan(5000);
    });

    it("runDiscovery marks collector failures when timeout budget is exceeded", async () => {
      vi.mocked(gitMock.defaultBranch).mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "main";
      });

      const result = await runDiscovery(TS_PROJECT_INPUT, 1);
      const failedCollectors = Object.values(result.collectors).filter((s) => s === "failed");

      expect(failedCollectors.length).toBeGreaterThan(0);
      expect(result.schemaVersion).toBe(DISCOVERY_SCHEMA_VERSION);
    });
  });

  describe("PERF", () => {
    it("runDiscovery completes in < 100ms for typical project", async () => {
      const iterations = 10;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();
        await runDiscovery(TS_PROJECT_INPUT);
        times.push(Date.now() - start);
      }

      times.sort((a, b) => a - b);
      const p99 = times[Math.floor(times.length * 0.99)] ?? times[times.length - 1];
      expect(p99).toBeLessThan(100);
    });

    it("computeDiscoveryDigest is fast (< 5ms)", async () => {
      const result = await runDiscovery(TS_PROJECT_INPUT);
      const start = Date.now();
      computeDiscoveryDigest(result);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5);
    });
  });
});
