/**
 * Runtime Assertion Provider Conformance Tests
 *
 * Exercises the full production pipeline against real fixture projects:
 *   collectStack → planVerificationCandidates → prepareVerificationExecution
 *   → executeCheck → collectAssertionReports → completeAssertionExtraction
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

import { collectStack } from '../../../src/discovery/collectors/stack-detection.js';
import { planVerificationCandidates } from '../../../src/discovery/verification-planner.js';
import { prepareVerificationExecution } from '../../../src/verification/verification-execution.js';
import { executeCheck } from '../../../src/verification/executor.js';
import { completeAssertionExtraction } from '../../../src/verification/assertion-extractor.js';
import type { CollectorInput, DetectedItem } from '../../../src/discovery/types.js';
import type { VerificationCandidate } from '../../../src/state/discovery-schemas.js';
import type { DetectedStack, DetectedStackItem } from '../../../src/state/discovery-schemas.js';

const runIf = process.env.FLOWGUARD_RUNTIME_CONFORMANCE === '1' ? it : it.skip;
const PROJECTS_ROOT = join(import.meta.dirname, 'projects');

// ─── Convert collector StackInfo → DetectedStack ─────────────────────────

const KIND_MAP: Record<string, DetectedStackItem['kind']> = {
  languages: 'language',
  frameworks: 'framework',
  buildTools: 'buildTool',
  testFrameworks: 'testFramework',
  runtimes: 'runtime',
  tools: 'tool',
  qualityTools: 'qualityTool',
  databases: 'database',
};

function toDetectedStack(info: Record<string, DetectedItem[]>): DetectedStack | null {
  const items: DetectedStackItem[] = [];
  for (const [category, detectedItems] of Object.entries(info)) {
    const kind = KIND_MAP[category];
    if (!kind || !Array.isArray(detectedItems)) continue;
    for (const item of detectedItems) {
      items.push({
        kind,
        id: item.id,
        version: item.version,
        evidence: item.evidence?.[0],
      });
    }
  }
  if (items.length === 0) return null;
  return {
    summary: items.map((i) => `${i.kind}:${i.id}`).join(', '),
    items,
    versions: items
      .filter((i) => i.version)
      .map((i) => ({
        id: i.id,
        version: i.version!,
        target: i.kind,
        ...(i.evidence ? { evidence: i.evidence } : {}),
      })),
  };
}

// ─── Per-project expected localIds (subset for identity verification) ────

const EXPECTED_LOCAL_IDS: Record<string, string[]> = {
  'maven-junit': [
    'com.example.CalculatorTest#testAddition',
    'com.example.CalculatorTest#testFailingAssertion',
    'com.example.CalculatorTest#testSkipped',
    'com.example.CalculatorTest$AdvancedOperations#testNestedFailing',
    'com.example.CalculatorTest$AdvancedOperations#testMultiplication',
  ],
  'gradle-junit': [
    'com.example.CalculatorTest#testAddition',
    'com.example.CalculatorTest#testFailingAssertion',
    'com.example.CalculatorTest#testSkipped',
  ],
  vitest: ['src/math.test.ts::calculator::add::adds two positive numbers'],
  jest: ['src/math.test.js::calculator::add::adds two positive numbers'],
  pytest: [
    'tests/test_math.py::test_addition',
    'tests/test_math.py::test_failing_assertion',
    'tests/test_math.py::test_parametrized[2-3-5]',
    'tests/test_math.py::TestMultiply::test_positive',
  ],
  go: ['flowguard-conformance-go::TestAddition'],
};

interface RuntimeFixture {
  readonly name: string;
  readonly expectedAssertionCount: number;
}

const FIXTURES: RuntimeFixture[] = [
  { name: 'maven-junit', expectedAssertionCount: 6 },
  { name: 'gradle-junit', expectedAssertionCount: 6 },
  { name: 'vitest', expectedAssertionCount: 6 },
  { name: 'jest', expectedAssertionCount: 6 },
  { name: 'pytest', expectedAssertionCount: 11 },
  { name: 'go', expectedAssertionCount: 5 },
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
        `full pipeline: Discovery → Candidate → prepare → execute → extract`,
        async () => {
          const tmpDir = await mkdtemp(join(tmpdir(), `fg-rt-${fixture.name}-`));
          await cp(join(PROJECTS_ROOT, fixture.name), tmpDir, { recursive: true });

          const allFiles = await collectAllFiles(tmpDir);
          const packageFiles = allFiles.filter(
            (f) =>
              f.endsWith('package.json') ||
              f.endsWith('pom.xml') ||
              f.endsWith('pyproject.toml') ||
              f.endsWith('go.mod'),
          );
          const configFiles = allFiles.filter(
            (f) =>
              f.includes('vitest.config') ||
              f.includes('jest.config') ||
              f.includes('build.gradle') ||
              f.includes('settings.gradle'),
          );

          const readFileFn = async (
            relativePath: string,
          ): Promise<string | undefined> => {
            try {
              return await readFile(join(tmpDir, relativePath), 'utf-8');
            } catch {
              return undefined;
            }
          };

          const collectorInput: CollectorInput = {
            worktreePath: tmpDir,
            fingerprint: `runtime-conformance-${fixture.name}`,
            allFiles,
            packageFiles,
            configFiles,
            readFile: readFileFn,
          };

          const stackOutput = await collectStack(collectorInput);
          const detectedStack = toDetectedStack(stackOutput.data);

          const candidates = await planVerificationCandidates({
            detectedStack,
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
            if (prepared.assertion.report.kind === 'run_specific') {
              const resultDir = join(
                tmpDir,
                dirname(prepared.assertion.report.resultPattern),
              );
              await mkdir(resultDir, { recursive: true });
            }

            const execution = await executeCheck({
              kind: prepared.kind,
              command: prepared.command,
              cwd: tmpDir,
            });

            expect(execution.command).toBe(prepared.command);

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
              `extraction status: ${extraction.status} reason: ${'reason' in extraction ? (extraction as { reason: string }).reason : 'n/a'}`,
            ).toBe('extracted');

            // exitCode from test runner must be non-zero (fixtures have failures)
            expect(
              execution.exitCode,
              `${fixture.name}: test process exitCode is 0 but fixture has failing tests`,
            ).not.toBe(0);

            expect(extraction.status).toBe('extracted');

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

              // Verify expected localId substrings are present in at least one assertion
              // Runtime paths differ from golden fixtures (temp dir copies) so use suffix matching
              const expectedSuffixes = EXPECTED_LOCAL_IDS[fixture.name];
              if (expectedSuffixes) {
                for (const suffix of expectedSuffixes) {
                  const found = extraction.assertions.some(
                    (a) => a.assertion.localId.endsWith(suffix),
                  );
                  expect(
                    found,
                    `${fixture.name}: no assertion localId ending with: ${suffix}. Found: ${localIds.join(', ')}`,
                  ).toBe(true);
                }
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
