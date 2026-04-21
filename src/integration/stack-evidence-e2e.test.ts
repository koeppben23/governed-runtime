/**
 * @module integration/stack-evidence-e2e.test
 * @description End-to-end pipeline tests proving that manifest-detected
 * stack versions flow through all three layers:
 *
 *   manifest file → repoSignals → hydrate/discovery
 *   → SessionState.detectedStack → flowguard_status.detectedStack
 *   → profileRules phase instruction
 *
 * Each test uses real manifest files on disk, real discovery extraction,
 * real persistence, and real status surfacing. Only the git adapter
 * (remoteOriginUrl, changedFiles, listRepoSignals) is mocked — with
 * per-test overrides to match the manifest files created on disk.
 *
 * Scope: Cross-cutting pipeline integration.
 * NOT in scope: Individual collector logic (see discovery.test.ts),
 * individual tool behavior (see tools-execute.test.ts).
 *
 * @test-policy HAPPY, BAD, CORNER — focused pipeline proof.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers';
import { status, hydrate } from './tools';
import { readState, writeState } from '../adapters/persistence';

// ─── Git Mock ────────────────────────────────────────────────────────────────

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

const gitMock = await import('../adapters/git');

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write a file into the test workspace (creating parent dirs as needed). */
async function writeManifest(name: string, content: string): Promise<void> {
  const fullPath = path.join(ws.tmpDir, name);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

/** Resolve the session directory for state read/write. */
async function resolveSessionDir(): Promise<string> {
  const { computeFingerprint, sessionDir: resolveSessDir } = await import('../adapters/workspace');
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessDir(fp.fingerprint, ctx.sessionID);
}

/** Hydrate a session and return the parsed tool result. */
async function hydrateSession(
  overrides: { policyMode?: string; profileId?: string } = {},
): Promise<Record<string, unknown>> {
  const raw = await hydrate.execute(
    { policyMode: overrides.policyMode ?? 'solo', profileId: overrides.profileId ?? 'baseline' },
    ctx,
  );
  return parseToolResult(raw);
}

/** Call status and return the parsed tool result. */
async function callStatus(): Promise<Record<string, unknown>> {
  return parseToolResult(await status.execute({}, ctx));
}

// ─── Manifest Templates ─────────────────────────────────────────────────────

const JAVA_POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.1</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <properties>
    <java.version>21</java.version>
  </properties>
</project>`;

const NODE_NVMRC = '20.11.0\n';

const TS_PACKAGE_JSON = JSON.stringify({ name: 'test-project', private: true });

const TS_TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true } });

// ─── Version Evidence Rule ──────────────────────────────────────────────────

/**
 * Single-line substring from DETECTED_STACK_INSTRUCTION that proves the
 * version-evidence rule reached profileRules. Must NOT span a line break
 * (template literals preserve \n — the "line-break gotcha").
 *
 * "version-specific claims without repository evidence" is unique to
 * DETECTED_STACK_INSTRUCTION and does not appear in any profile's base content.
 */
const VERSION_EVIDENCE_RULE = 'version-specific claims without repository evidence';

// =============================================================================
// Tests
// =============================================================================

describe('stack-evidence E2E', () => {
  // ─── HAPPY ───────────────────────────────────────────────────────────────

  describe('HAPPY', () => {
    it('Java project: pom.xml versions flow through full pipeline to status', async () => {
      // 1. Write manifest on disk
      await writeManifest('pom.xml', JAVA_POM_XML);
      await writeManifest('src/main/java/App.java', '// placeholder');

      // 2. Override repoSignals to match workspace contents
      vi.mocked(gitMock.listRepoSignals).mockResolvedValueOnce({
        files: ['pom.xml', 'src/main/java/App.java'],
        packageFiles: ['pom.xml'],
        configFiles: [],
      });

      // 3. Hydrate — runs real discovery with real file reads
      const hydrateResult = await hydrateSession();

      // 4. Verify profile auto-detection (Java scores 0.8)
      expect(hydrateResult.profileId).toBe('backend-java');

      // 5. Verify state.detectedStack via persistence
      const sessDir = await resolveSessionDir();
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.detectedStack).not.toBeNull();

      const ds = state!.detectedStack!;
      expect(ds.summary).toContain('java=21');
      expect(ds.summary).toContain('spring-boot=3.4.1');

      // items[] contains ALL detected items (versioned + unversioned)
      expect(Array.isArray(ds.items)).toBe(true);
      expect(ds.items.length).toBeGreaterThanOrEqual(2);
      expect(ds.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'language', id: 'java', version: '21' }),
          expect.objectContaining({ kind: 'framework', id: 'spring-boot', version: '3.4.1' }),
        ]),
      );

      // versions[] backward compat — only versioned items
      expect(ds.versions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'java',
            version: '21',
            target: 'language',
            evidence: 'pom.xml:<java.version>',
          }),
          expect.objectContaining({
            id: 'spring-boot',
            version: '3.4.1',
            target: 'framework',
          }),
        ]),
      );

      // 6. Verify flowguard_status surfaces full object (not summary string)
      const statusResult = await callStatus();
      expect(statusResult.detectedStack).not.toBeNull();
      expect(typeof statusResult.detectedStack).toBe('object');

      const statusDs = statusResult.detectedStack as Record<string, unknown>;
      expect(statusDs.summary).toContain('java=21');
      expect(Array.isArray(statusDs.items)).toBe(true);
      expect((statusDs.items as unknown[]).length).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(statusDs.versions)).toBe(true);
      expect((statusDs.versions as unknown[]).length).toBeGreaterThanOrEqual(2);

      // 7. Verify PLAN phase profileRules contains version-evidence rule
      await writeState(sessDir, { ...state!, phase: 'PLAN' });
      const planStatus = await callStatus();
      expect(planStatus.profileRules).toContain(VERSION_EVIDENCE_RULE);
    });

    it('Java project: version-evidence rule is phase-gated to relevant phases', async () => {
      // Setup: Java workspace
      await writeManifest('pom.xml', JAVA_POM_XML);
      vi.mocked(gitMock.listRepoSignals).mockResolvedValueOnce({
        files: ['pom.xml', 'src/main/java/App.java'],
        packageFiles: ['pom.xml'],
        configFiles: [],
      });
      await hydrateSession();
      const sessDir = await resolveSessionDir();
      const state = await readState(sessDir);
      expect(state).not.toBeNull();

      // Phases that MUST include the rule
      for (const phase of ['PLAN', 'IMPLEMENTATION', 'IMPL_REVIEW', 'REVIEW'] as const) {
        await writeState(sessDir, { ...state!, phase });
        const result = await callStatus();
        expect(result.profileRules).toContain(VERSION_EVIDENCE_RULE);
      }

      // READY phase must NOT include the rule (no byPhase override)
      await writeState(sessDir, { ...state!, phase: 'READY' });
      const readyResult = await callStatus();
      expect(readyResult.profileRules).not.toContain(VERSION_EVIDENCE_RULE);
    });

    it('TypeScript project: .nvmrc version flows through pipeline to status', async () => {
      // 1. Write manifests on disk
      await writeManifest('.nvmrc', NODE_NVMRC);
      await writeManifest('package.json', TS_PACKAGE_JSON);
      await writeManifest('tsconfig.json', TS_TSCONFIG);

      // 2. Override repoSignals
      vi.mocked(gitMock.listRepoSignals).mockResolvedValueOnce({
        files: ['.nvmrc', 'package.json', 'tsconfig.json', 'src/index.ts'],
        packageFiles: ['package.json'],
        configFiles: ['tsconfig.json'],
      });

      // 3. Hydrate
      const hydrateResult = await hydrateSession();

      // 4. Verify TypeScript profile auto-detected (score 0.7 via tsconfig.json)
      expect(hydrateResult.profileId).toBe('typescript');

      // 5. Verify state.detectedStack contains node version from .nvmrc
      const sessDir = await resolveSessionDir();
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.detectedStack).not.toBeNull();

      const ds = state!.detectedStack!;
      expect(ds.summary).toContain('node=20.11.0');
      expect(ds.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtime',
            id: 'node',
            version: '20.11.0',
          }),
        ]),
      );
      expect(ds.versions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'node',
            version: '20.11.0',
            target: 'runtime',
            evidence: '.nvmrc',
          }),
        ]),
      );

      // 6. Status surfaces full object
      const statusResult = await callStatus();
      expect(statusResult.detectedStack).not.toBeNull();
      const statusDs = statusResult.detectedStack as Record<string, unknown>;
      expect(statusDs.summary).toContain('node=20.11.0');
      expect(Array.isArray(statusDs.items)).toBe(true);
      expect(Array.isArray(statusDs.versions)).toBe(true);

      // 7. PLAN phase profileRules contains version-evidence rule
      await writeState(sessDir, { ...state!, phase: 'PLAN' });
      const planStatus = await callStatus();
      expect(planStatus.profileRules).toContain(VERSION_EVIDENCE_RULE);
    });
  });

  // ─── BAD ─────────────────────────────────────────────────────────────────

  describe('BAD', () => {
    it('no manifest files: detectedStack has unversioned items only', async () => {
      // Default mock signals list tsconfig.json + package.json + src/index.ts
      // but manifests do not exist on disk — readFile returns undefined for
      // version-bearing content. Stack detection still recognizes unversioned
      // items (typescript from .ts files, npm from package.json presence).
      await hydrateSession();

      // Verify state — P10: unversioned items are surfaced
      const sessDir = await resolveSessionDir();
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.detectedStack).not.toBeNull();

      const ds = state!.detectedStack!;
      expect(ds.items.length).toBeGreaterThan(0);
      expect(ds.versions).toHaveLength(0); // no versioned items

      // Verify status surfaces full object (not null)
      const result = await callStatus();
      expect(result.detectedStack).not.toBeNull();
      const statusDs = result.detectedStack as Record<string, unknown>;
      expect(Array.isArray(statusDs.items)).toBe(true);
      expect((statusDs.items as unknown[]).length).toBeGreaterThan(0);
    });
  });

  // ─── CORNER ──────────────────────────────────────────────────────────────

  describe('CORNER', () => {
    it('detectedStack is a structured object, never a plain string', async () => {
      // Setup: Java workspace with known versions
      await writeManifest('pom.xml', JAVA_POM_XML);
      vi.mocked(gitMock.listRepoSignals).mockResolvedValueOnce({
        files: ['pom.xml', 'src/main/java/App.java'],
        packageFiles: ['pom.xml'],
        configFiles: [],
      });
      await hydrateSession();

      const result = await callStatus();
      const ds = result.detectedStack;

      // Must be an object, never a string (regression guard for .summary surfacing)
      expect(ds).not.toBeNull();
      expect(typeof ds).toBe('object');
      expect(typeof ds).not.toBe('string');

      // Structural shape assertions
      const obj = ds as Record<string, unknown>;
      expect(typeof obj.summary).toBe('string');
      expect(Array.isArray(obj.items)).toBe(true);
      expect(Array.isArray(obj.versions)).toBe(true);

      // Each item has required fields
      const items = obj.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(typeof item.id).toBe('string');
        expect([
          'language',
          'framework',
          'runtime',
          'buildTool',
          'tool',
          'testFramework',
          'qualityTool',
        ]).toContain(item.kind);
        // version is optional — string or undefined
        if (item.version !== undefined) {
          expect(typeof item.version).toBe('string');
        }
        // evidence is optional — string or undefined
        if (item.evidence !== undefined) {
          expect(typeof item.evidence).toBe('string');
        }
      }

      // Each version entry has required fields (backward compat)
      const versions = obj.versions as Array<Record<string, unknown>>;
      for (const v of versions) {
        expect(typeof v.id).toBe('string');
        expect(typeof v.version).toBe('string');
        expect([
          'language',
          'framework',
          'runtime',
          'buildTool',
          'tool',
          'testFramework',
          'qualityTool',
        ]).toContain(v.target);
        // evidence is optional — string or undefined, never fabricated
        if (v.evidence !== undefined) {
          expect(typeof v.evidence).toBe('string');
        }
      }
    });
  });
});
