import { describe, expect, it } from 'vitest';

import type { DetectedStack } from './types.js';
import {
  comparePlannedCandidates,
  extractExecutionSubjectInputs,
  extractExecutionSubjectInputsByCandidateId,
  planVerificationCandidates,
  stripToCandidates,
} from './verification-planner.js';

function makeDetectedStack(items: DetectedStack['items']): DetectedStack {
  return {
    summary: items.map((item) => item.id).join(', '),
    items,
    versions: items
      .filter((item) => item.version)
      .map((item) => ({
        id: item.id,
        version: item.version!,
        target: item.kind,
      })),
  };
}

function makeReadFile(files: Record<string, string | undefined>) {
  return async (relativePath: string): Promise<string | undefined> => files[relativePath];
}

async function plan(input: {
  detectedStack?: DetectedStack | null;
  allFiles?: string[];
  readFile?: ReturnType<typeof makeReadFile>;
}) {
  return planVerificationCandidates({
    detectedStack: input.detectedStack ?? null,
    allFiles: input.allFiles ?? ['package.json'],
    readFile: input.readFile ?? makeReadFile({}),
  });
}

describe('verification planner — mutation coverage', () => {
  describe('package manager detection', () => {
    it('prefers a buildTool stack item over lock files', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([
          { kind: 'buildTool', id: 'yarn', evidence: 'yarn.lock' },
          { kind: 'language', id: 'typescript', evidence: 'tsconfig.json' },
        ]),
        allFiles: ['yarn.lock', 'package.json'],
      });
      expect(candidates[0]!.candidate.command).toBe('yarn tsc --noEmit');
    });

    it('derives pnpm from the root lock file', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([
          { kind: 'language', id: 'typescript', evidence: 'tsconfig.json' },
        ]),
        allFiles: ['pnpm-lock.yaml', 'package.json'],
      });
      expect(candidates[0]!.candidate.command).toBe('pnpm tsc --noEmit');
    });

    it('derives yarn from yarn.lock', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([
          { kind: 'language', id: 'typescript', evidence: 'tsconfig.json' },
        ]),
        allFiles: ['yarn.lock', 'package.json'],
      });
      expect(candidates[0]!.candidate.command).toBe('yarn tsc --noEmit');
    });

    it('derives bun from bun.lock and bun.lockb', async () => {
      for (const lock of ['bun.lock', 'bun.lockb']) {
        const candidates = await plan({
          detectedStack: makeDetectedStack([
            { kind: 'language', id: 'typescript', evidence: 'tsconfig.json' },
          ]),
          allFiles: [lock, 'package.json'],
        });
        expect(candidates[0]!.candidate.command).toBe('bunx tsc --noEmit');
      }
    });

    it('ignores non-buildTool stack items with a package-manager id', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([
          { kind: 'tool', id: 'yarn', evidence: 'yarn.lock' },
          { kind: 'language', id: 'typescript', evidence: 'tsconfig.json' },
        ]),
        allFiles: ['package.json'],
      });
      expect(candidates[0]!.candidate.command).toBe('npx tsc --noEmit');
    });
  });

  describe('root file filtering', () => {
    it('ignores nested lock files (slash and backslash paths)', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([
          { kind: 'language', id: 'typescript', evidence: 'tsconfig.json' },
        ]),
        allFiles: ['sub/pnpm-lock.yaml', 'win\\yarn.lock', 'package.json'],
      });
      expect(candidates[0]!.candidate.command).toBe('npx tsc --noEmit');
    });
  });

  describe('package.json script parsing', () => {
    it('treats a null package.json body as no scripts', async () => {
      const candidates = await plan({ readFile: makeReadFile({ 'package.json': 'null' }) });
      expect(candidates).toEqual([]);
    });

    it('treats non-object scripts entries as no scripts', async () => {
      for (const body of ['{"scripts": "nope"}', '{"scripts": 42}']) {
        const candidates = await plan({ readFile: makeReadFile({ 'package.json': body }) });
        expect(candidates).toEqual([]);
      }
    });

    it('ignores non-string and whitespace-only script values', async () => {
      const candidates = await plan({
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { test: 42, lint: '   ' } }),
        }),
      });
      expect(candidates).toEqual([]);
    });

    it('keeps only the first script when two map to the same kind', async () => {
      const candidates = await plan({
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { coverage: 'npm run coverage:primary', 'test:coverage': 'npm run other' },
          }),
        }),
      });
      expect(candidates.map((c) => c.candidate.kind)).toEqual(['coverage']);
      expect(candidates[0]!.candidate.command).toBe('npm run coverage --');
    });
  });

  describe('script enrichment diagnostics', () => {
    it('reports compound shell commands in the candidate reason', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([
          { kind: 'buildTool', id: 'npm', evidence: 'package.json' },
        ]),
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'vitest run && npm run lint' },
          }),
        }),
      });
      const test = candidates.find((c) => c.candidate.kind === 'test')!;
      expect(test.candidate.assertionCapability).toBe('unsupported');
      expect(test.candidate.reason).toContain('compound shell command');
    });

    it('reports existing reporter configuration in the candidate reason', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([
          { kind: 'buildTool', id: 'npm', evidence: 'package.json' },
        ]),
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'vitest --reporter=junit' },
          }),
        }),
      });
      const test = candidates.find((c) => c.candidate.kind === 'test')!;
      expect(test.candidate.reason).toContain('reporter configuration detected');
    });
  });

  describe('placeholder script detection', () => {
    it('ignores upper-case placeholders', async () => {
      const candidates = await plan({
        readFile: makeReadFile({ 'package.json': JSON.stringify({ scripts: { test: 'TODO' } }) }),
      });
      expect(candidates).toEqual([]);
    });

    it('ignores echo no-test-specified variants', async () => {
      for (const script of [
        'echo error: no test specified',
        'echo "No test specified" && exit 1',
        'echo `todo`',
        'echo not implemented && exit 1',
      ]) {
        const candidates = await plan({
          readFile: makeReadFile({ 'package.json': JSON.stringify({ scripts: { test: script } }) }),
        });
        expect(candidates).toEqual([]);
      }
    });
  });

  describe('non-assertion fallbacks', () => {
    it('adds the Maven build fallback without wrapper evidence', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([{ kind: 'buildTool', id: 'maven', evidence: 'pom.xml' }]),
        allFiles: ['pom.xml', 'package.json'],
      });
      expect(candidates.map((c) => c.candidate.kind)).toEqual(['build']);
      expect(candidates[0]!.candidate.command).toBe('mvn verify');
    });

    it('adds the Gradle test fallback for gradle and gradle-kotlin', async () => {
      for (const id of ['gradle', 'gradle-kotlin'] as const) {
        const candidates = await plan({
          detectedStack: makeDetectedStack([{ kind: 'buildTool', id, evidence: 'build.gradle' }]),
          allFiles: ['build.gradle', 'package.json'],
        });
        expect(candidates.map((c) => c.candidate.kind)).toEqual(['test']);
        expect(candidates[0]!.candidate.command).toBe('gradle check');
        expect(candidates[0]!.candidate.source).toBe(`detectedStack:buildTool:${id}`);
      }
    });

    it('adds the ESLint fallback for qualityTool and tool detections', async () => {
      for (const kind of ['qualityTool', 'tool'] as const) {
        const candidates = await plan({
          detectedStack: makeDetectedStack([{ kind, id: 'eslint', evidence: 'eslint.config.js' }]),
          allFiles: ['eslint.config.js', 'package.json'],
        });
        expect(candidates.map((c) => c.candidate.kind)).toEqual(['lint']);
        expect(candidates[0]!.candidate.source).toBe(`detectedStack:${kind}:eslint`);
      }
    });

    it('adds the TypeScript fallback for language and tool detections', async () => {
      for (const kind of ['language', 'tool'] as const) {
        const candidates = await plan({
          detectedStack: makeDetectedStack([{ kind, id: 'typescript', evidence: 'tsconfig.json' }]),
          allFiles: ['tsconfig.json', 'package.json'],
        });
        expect(candidates.map((c) => c.candidate.kind)).toEqual(['typecheck']);
        expect(candidates[0]!.candidate.source).toBe(`detectedStack:${kind}:typescript`);
        expect(candidates[0]!.candidate.confidence).toBe(kind === 'language' ? 'low' : 'low');
      }
    });

    it('keeps the repo-native script over the Maven fallback', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([{ kind: 'buildTool', id: 'maven', evidence: 'pom.xml' }]),
        allFiles: ['pom.xml', 'package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { build: 'npm run build:real' } }),
        }),
      });
      const build = candidates.find((c) => c.candidate.kind === 'build')!;
      expect(build.candidate.command).toBe('npm run build --');
    });

    it('does not enrich a script whose provider candidate kind differs from the script kind', async () => {
      const candidates = await plan({
        detectedStack: makeDetectedStack([
          { kind: 'buildTool', id: 'npm', evidence: 'package.json' },
        ]),
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { coverage: 'vitest run' } }),
        }),
      });
      expect(candidates.some((c) => c.candidate.kind === 'coverage')).toBe(false);
    });
  });

  describe('placeholder literal detection', () => {
    it('ignores the bare exit-1, todo, and not-implemented literals', async () => {
      for (const script of ['exit 1', 'todo', 'not implemented']) {
        const candidates = await plan({
          readFile: makeReadFile({ 'package.json': JSON.stringify({ scripts: { test: script } }) }),
        });
        expect(candidates).toEqual([]);
      }
    });
  });

  describe('comparePlannedCandidates', () => {
    const entry = (kind: string, command: string) =>
      ({
        candidate: {
          assertionCapability: 'unsupported' as const,
          kind: kind as never,
          command,
          source: 'test',
          confidence: 'high' as const,
          reason: 'test',
        },
        executionSubjectInputs: [],
      }) as Parameters<typeof comparePlannedCandidates>[0];

    it('orders earlier verification kinds first', () => {
      expect(comparePlannedCandidates(entry('test', 'a'), entry('lint', 'a'))).toBeLessThan(0);
      expect(comparePlannedCandidates(entry('lint', 'a'), entry('test', 'a'))).toBeGreaterThan(0);
    });

    it('breaks kind ties by command locale order', () => {
      expect(comparePlannedCandidates(entry('test', 'a'), entry('test', 'b'))).toBeLessThan(0);
      expect(comparePlannedCandidates(entry('test', 'b'), entry('test', 'a'))).toBeGreaterThan(0);
      expect(comparePlannedCandidates(entry('test', 'a'), entry('test', 'a'))).toBe(0);
    });
  });

  describe('candidate extraction helpers', () => {
    const planned = (candidateId: string | undefined, subjectInputs: unknown[]) => ({
      candidate: {
        assertionCapability: 'unsupported' as const,
        kind: 'test' as const,
        command: 'npm test',
        source: 'package.json',
        confidence: 'high' as const,
        reason: 'test',
        ...(candidateId ? { candidateId } : {}),
      },
      executionProfileId: 'vitest-fallback',
      scopeSemanticCommand: 'npm test',
      executionSubjectInputs: subjectInputs,
    });

    it('stripToCandidates drops the execution profile id', () => {
      const stripped = stripToCandidates([planned('vc_1', [])] as never);
      expect(stripped[0]).not.toHaveProperty('executionProfileId');
      expect(stripped[0]!.candidateId).toBe('vc_1');
    });

    it('extractExecutionSubjectInputs omits entries without subject inputs', () => {
      const map = extractExecutionSubjectInputs([
        planned(undefined, []),
        planned(undefined, [{ kind: 'implementation' }]),
      ] as never);
      expect(Object.keys(map)).toEqual(['test']);
    });

    it('extractExecutionSubjectInputsByCandidateId omits entries without a candidateId', () => {
      const map = extractExecutionSubjectInputsByCandidateId([
        planned(undefined, [{ kind: 'implementation' }]),
        planned('vc_1', [{ kind: 'file', path: 'package.json' }]),
      ] as never);
      expect(map).toEqual({ vc_1: [{ kind: 'file', path: 'package.json' }] });
    });
  });
});
