/**
 * Runtime Assertion Provider Conformance Tests
 *
 * Exercises the full production pipeline (Candidate → prepare → execute →
 * collect → extract) against real fixture projects with pinned toolchain
 * versions. Discovery is exercised through explicit stack construction
 * that mirrors what the production orchestrator would produce.
 *
 * Gated behind FLOWGUARD_RUNTIME_CONFORMANCE=1 — these tests run only in CI
 * where all toolchains (Maven, Gradle, Node, Python, Go) are pre-installed.
 *
 * Executing:
 *   FLOWGUARD_RUNTIME_CONFORMANCE=1 npx vitest run --project conformance \
 *     test/conformance/assertions/assertion-runtime-conformance.test.ts
 */

import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, cp, readdir, mkdir } from 'node:fs/promises';

import { planVerificationCandidates } from '../../../src/discovery/verification-planner.js';
import { prepareVerificationExecution } from '../../../src/verification/verification-execution.js';
import { executeCheck } from '../../../src/verification/executor.js';
import { completeAssertionExtraction } from '../../../src/verification/assertion-extractor.js';
import type { VerificationCandidate } from '../../../src/state/discovery-schemas.js';
import type {
  DetectedStack,
  DetectedStackItem,
} from '../../../src/state/discovery-schemas.js';

const runIf = process.env.FLOWGUARD_RUNTIME_CONFORMANCE === '1' ? it : it.skip;
const PROJECTS_ROOT = join(import.meta.dirname, 'projects');

// ─── Per-project detected stacks ──────────────────────────────────────────

function detectedStack(
  summary: string,
  items: readonly DetectedStackItem[],
): DetectedStack {
  return {
    summary,
    items: [...items],
    versions: items
      .filter((i) => i.version !== undefined)
      .map((i) => ({
        id: i.id,
        version: i.version!,
        target: i.kind,
        ...(i.evidence ? { evidence: i.evidence } : {}),
      })),
  };
}

function npmStack(framework: string): DetectedStack {
  return detectedStack(`buildTool:npm, testFramework:${framework}`, [
    { kind: 'buildTool', id: 'npm', evidence: 'package.json' },
    { kind: 'testFramework', id: framework, evidence: 'package.json' },
  ]);
}

function pythonStack(): DetectedStack {
  return detectedStack('testFramework:pytest', [
    { kind: 'testFramework', id: 'pytest', evidence: 'pyproject.toml' },
  ]);
}

function mavenStack(): DetectedStack {
  return detectedStack('buildTool:maven', [
    { kind: 'buildTool', id: 'maven', evidence: 'pom.xml' },
  ]);
}

function gradleStack(): DetectedStack {
  return detectedStack('buildTool:gradle', [
    { kind: 'buildTool', id: 'gradle', evidence: 'build.gradle.kts' },
  ]);
}

function goStack(): DetectedStack {
  return detectedStack('language:go, testFramework:go_test', [
    { kind: 'language', id: 'go', evidence: 'go.mod' },
    { kind: 'testFramework', id: 'go_test', evidence: 'go.mod' },
  ]);
}

interface RuntimeFixture {
  readonly name: string;
  readonly stack: DetectedStack;
  readonly expectedAssertionCount: number;
}

const FIXTURES: RuntimeFixture[] = [
  { name: 'maven-junit', stack: mavenStack(), expectedAssertionCount: 6 },
  { name: 'gradle-junit', stack: gradleStack(), expectedAssertionCount: 6 },
  { name: 'vitest', stack: npmStack('vitest'), expectedAssertionCount: 6 },
  { name: 'jest', stack: npmStack('jest'), expectedAssertionCount: 6 },
  { name: 'pytest', stack: pythonStack(), expectedAssertionCount: 11 },
  { name: 'go', stack: goStack(), expectedAssertionCount: 5 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function findAssertionCandidate(
  candidates: VerificationCandidate[],
): VerificationCandidate | undefined {
  for (const c of candidates) {
    if (c.kind === 'test' || c.kind === 'build') {
      if (c.assertionCapability === 'structured') {
        return c;
      }
    }
  }
  return candidates.find((c) => c.assertionCapability === 'structured');
}

async function collectAllFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const { join: j } = await import('node:path');

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = j(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.venv' ||
          entry.name === 'target' ||
          entry.name === 'build' ||
          entry.name === '.gradle' ||
          entry.name === '.mvn' ||
          entry.name === 'gradle'
        )
          continue;
        await walk(full);
      } else {
        const rel = full.slice(dir.length + 1);
        results.push(rel);
      }
    }
  };

  await walk(dir);
  return results;
}

// ─── Suite ────────────────────────────────────────────────────────────────

describe('Runtime Assertion Provider Conformance', () => {
  for (const fixture of FIXTURES) {
    describe(`[${fixture.name}] end-to-end pipeline`, () => {
      runIf(
        `full pipeline: Candidate → prepare → execute → extract`,
        async () => {
          const tmpDir = await mkdtemp(join(tmpdir(), `fg-rt-${fixture.name}-`));
          await cp(join(PROJECTS_ROOT, fixture.name), tmpDir, { recursive: true });

          const allFiles = await collectAllFiles(tmpDir);

          const readFileFn = async (
            relativePath: string,
          ): Promise<string | undefined> => {
            try {
              return await readFile(join(tmpDir, relativePath), 'utf-8');
            } catch {
              return undefined;
            }
          };

          const candidates = await planVerificationCandidates({
            detectedStack: fixture.stack,
            allFiles,
            readFile: readFileFn,
          });

          const testCandidate = findAssertionCandidate(candidates);
          expect(
            testCandidate,
            `no structured assertion candidate found for ${fixture.name}. candidates: ${JSON.stringify(candidates.map((c) => ({ kind: c.kind, cap: c.assertionCapability, cmd: c.command })))}`,
          ).toBeDefined();

          const prepared = await prepareVerificationExecution(
            testCandidate!,
            tmpDir,
          );
          expect(prepared.assertion.capability).toBe('structured');

          if (prepared.assertion.capability === 'structured') {
            // Pre-create report output directories for run_specific collection
            if (prepared.assertion.report.kind === 'run_specific') {
              const resultDir = join(
                tmpDir,
                dirname(prepared.assertion.report.resultPattern),
              );
              await mkdir(resultDir, { recursive: true });
            }

            // Use venv's Python for pytest projects
            let cmd = prepared.command;
            if (fixture.name === 'pytest') {
              const venvPython = join(tmpDir, '.venv', 'bin', 'python');
              cmd = cmd.replace(/^python\s/, `${venvPython} `);
            }

            const execution = await executeCheck({
              kind: prepared.kind,
              command: cmd,
              cwd: tmpDir,
            });

            expect(execution.command).toBe(cmd);

            if (prepared.assertion.report.kind === 'run_specific') {
              expect(prepared.command).toContain(prepared.attemptId);
            }

            const extraction = await completeAssertionExtraction(
              prepared,
              execution,
              tmpDir,
            );

            expect(
              extraction.status,
              `extraction status: ${extraction.status} reason: ${'reason' in extraction ? extraction.reason : 'n/a'}`,
            ).toBe('extracted');

            if (extraction.status === 'extracted') {
              expect(extraction.attemptId).toBe(prepared.attemptId);
              expect(extraction.bindingCapability).toBe('assertion');
              expect(extraction.reportDigests.length).toBeGreaterThanOrEqual(1);
              expect(extraction.assertions.length).toBeGreaterThanOrEqual(
                fixture.expectedAssertionCount,
              );

              const localIds = extraction.assertions.map(
                (a) => a.assertion.localId,
              );
              expect(new Set(localIds).size).toBe(localIds.length);

              for (const a of extraction.assertions) {
                expect(a.providerId).toBe(extraction.providerId);
                expect(a.assertion.providerId).toBe(extraction.providerId);
                expect(a.assertion.localId.length).toBeGreaterThan(0);
              }

              const hasFailedAssertion = extraction.assertions.some(
                (a) => a.status === 'failed',
              );
              expect(hasFailedAssertion).toBe(true);

              if (execution.exitCode !== 0) {
                expect(extraction.status).toBe('extracted');
              }
            }
          }

          await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        },
        180000,
      );
    });
  }
});
