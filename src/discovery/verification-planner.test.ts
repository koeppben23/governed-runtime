import { describe, expect, it } from 'vitest';

import type { DetectedStack } from './types';
import { planVerificationCandidates } from './verification-planner';

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

describe('verification planner', () => {
  describe('HAPPY', () => {
    it('uses package scripts with detected pnpm and suppresses vitest fallback', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'pnpm', evidence: 'pnpm-lock.yaml' },
        { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['package.json', 'pnpm-lock.yaml', 'vitest.config.ts'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: {
              test: 'vitest run',
              lint: 'eslint .',
              build: 'vite build',
            },
          }),
        }),
      });

      expect(candidates.find((c) => c.kind === 'test')?.command).toBe('pnpm test');
      expect(candidates.map((c) => c.command)).not.toContain('pnpm vitest run');
      expect(candidates.find((c) => c.kind === 'test')?.source).toBe('package.json:scripts.test');
      expect(candidates.find((c) => c.kind === 'test')?.confidence).toBe('high');
    });

    it('uses vitest fallback when no test script exists', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'pnpm', evidence: 'pnpm-lock.yaml' },
        { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['package.json', 'pnpm-lock.yaml', 'vitest.config.ts'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
        }),
      });

      const testCandidate = candidates.find((c) => c.kind === 'test');
      expect(testCandidate).toBeDefined();
      expect(testCandidate?.command).toBe('pnpm vitest run');
      expect(testCandidate?.source).toBe('detectedStack:testFramework:vitest');
      expect(testCandidate?.confidence).toBe('medium');
    });

    it('prefers Maven wrapper over global Maven', async () => {
      const detectedStack = makeDetectedStack([{ kind: 'buildTool', id: 'maven', evidence: 'pom.xml' }]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['pom.xml', 'mvnw'],
        readFile: makeReadFile({}),
      });

      const buildCandidate = candidates.find((c) => c.kind === 'build');
      expect(buildCandidate?.command).toBe('./mvnw verify');
      expect(candidates.map((c) => c.command)).not.toContain('mvn verify');
    });

    it('uses Windows Maven wrapper command when only mvnw.cmd exists', async () => {
      const detectedStack = makeDetectedStack([{ kind: 'buildTool', id: 'maven', evidence: 'pom.xml' }]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['pom.xml', 'mvnw.cmd'],
        readFile: makeReadFile({}),
      });

      const buildCandidate = candidates.find((c) => c.kind === 'build');
      expect(buildCandidate?.command).toBe('mvnw.cmd verify');
      expect(candidates.map((c) => c.command)).not.toContain('mvn verify');
    });

    it('prefers Gradle wrapper over global Gradle', async () => {
      const detectedStack = makeDetectedStack([{ kind: 'buildTool', id: 'gradle', evidence: 'build.gradle' }]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['build.gradle', 'gradlew'],
        readFile: makeReadFile({}),
      });

      const testCandidate = candidates.find((c) => c.kind === 'test');
      expect(testCandidate?.command).toBe('./gradlew check');
      expect(candidates.map((c) => c.command)).not.toContain('gradle check');
    });

    it('uses Windows Gradle wrapper command when only gradlew.bat exists', async () => {
      const detectedStack = makeDetectedStack([{ kind: 'buildTool', id: 'gradle', evidence: 'build.gradle' }]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['build.gradle', 'gradlew.bat'],
        readFile: makeReadFile({}),
      });

      const testCandidate = candidates.find((c) => c.kind === 'test');
      expect(testCandidate?.command).toBe('gradlew.bat check');
      expect(candidates.map((c) => c.command)).not.toContain('gradle check');
    });
  });

  describe('BAD', () => {
    it('handles malformed package.json by falling back to detected tools', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'pnpm', evidence: 'pnpm-lock.yaml' },
        { kind: 'qualityTool', id: 'eslint', evidence: 'eslint.config.js' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['package.json', 'pnpm-lock.yaml'],
        readFile: makeReadFile({ 'package.json': '{invalid-json' }),
      });

      expect(candidates.find((c) => c.kind === 'lint')?.command).toBe('pnpm eslint .');
      expect(candidates.find((c) => c.kind === 'lint')?.source).toBe('detectedStack:qualityTool:eslint');
    });
  });

  describe('CORNER', () => {
    it('returns empty array when no verification evidence exists', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: null,
        allFiles: [],
        readFile: makeReadFile({}),
      });

      expect(candidates).toEqual([]);
    });

    it('keeps deterministic ordering by kind then command', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'pnpm', evidence: 'pnpm-lock.yaml' },
        { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
        { kind: 'qualityTool', id: 'eslint', evidence: 'eslint.config.js' },
        { kind: 'language', id: 'typescript', evidence: 'tsconfig.json' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['pnpm-lock.yaml', 'vitest.config.ts', 'eslint.config.js', 'tsconfig.json'],
        readFile: makeReadFile({}),
      });

      expect(candidates.map((c) => c.kind)).toEqual(['test', 'lint', 'typecheck']);
      expect(candidates.map((c) => c.command)).toEqual([
        'pnpm vitest run',
        'pnpm eslint .',
        'pnpm tsc --noEmit',
      ]);
    });
  });

  describe('EDGE', () => {
    it('ignores empty script values and continues with fallback', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'pnpm', evidence: 'pnpm-lock.yaml' },
        { kind: 'testFramework', id: 'jest', evidence: 'jest.config.js' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['package.json', 'pnpm-lock.yaml', 'jest.config.js'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { test: '   ' } }),
        }),
      });

      expect(candidates.find((c) => c.kind === 'test')?.command).toBe('pnpm jest');
    });

    it('ignores npm placeholder test script and continues with fallback', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'npm', evidence: 'package.json' },
        { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['package.json', 'vitest.config.ts'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: {
              test: 'echo "Error: no test specified" && exit 1',
            },
          }),
        }),
      });

      expect(candidates.find((c) => c.kind === 'test')?.command).toBe('npx vitest run');
      expect(candidates.map((c) => c.command)).not.toContain('npm run test');
    });
  });

  describe('SMOKE/PERF', () => {
    it('plans from large file lists within reasonable time', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'pnpm', evidence: 'pnpm-lock.yaml' },
        { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
      ]);
      const allFiles = Array.from({ length: 5000 }, (_, i) => `packages/p${i}/src/file.ts`);

      const started = performance.now();
      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: [...allFiles, 'package.json', 'pnpm-lock.yaml'],
        readFile: makeReadFile({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }),
      });
      const elapsedMs = performance.now() - started;

      expect(candidates.find((c) => c.kind === 'test')?.command).toBe('pnpm test');
      expect(elapsedMs).toBeLessThan(200);
    });
  });
});
