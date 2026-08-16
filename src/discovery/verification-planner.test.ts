import { describe, expect, it } from 'vitest';

import {
  extractExecutionSubjectInputsByCandidateId,
  planVerificationCandidates,
} from './verification-planner.js';
import { makeDetectedStack, makeReadFile } from './verification-planner-test-helpers.js';

describe('verification planner', () => {
  describe('HAPPY', () => {
    it('assigns deterministic IDs and candidate-specific subject inputs', async () => {
      const input = {
        detectedStack: makeDetectedStack([
          { kind: 'language' as const, id: 'typescript', evidence: 'tsconfig.json' },
        ]),
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
        }),
      };
      const first = await planVerificationCandidates(input);
      const second = await planVerificationCandidates(input);

      expect(first.map((entry) => entry.candidate.candidateId)).toEqual(
        second.map((entry) => entry.candidate.candidateId),
      );
      const candidate = first[0]!.candidate;
      expect(candidate.candidateId).toMatch(/^vc_[a-f0-9]{64}$/);
      expect(extractExecutionSubjectInputsByCandidateId(first)[candidate.candidateId!]).toEqual(
        first[0]!.executionSubjectInputs,
      );
    });

    it('structured Maven wrapper candidate is produced alongside package script test', async () => {
      // Remove build script — wrapper fills the gap. Test script stays as repo-native.
      const candidates = await planVerificationCandidates({
        detectedStack: makeDetectedStack([{ kind: 'buildTool', id: 'maven', evidence: 'pom.xml' }]),
        allFiles: ['package.json', 'pom.xml', 'mvnw'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: {
              test: './mvnw -Dtest=TaskControllerTest test',
            },
          }),
        }),
      });

      const buildCandidate = candidates.find((c) => c.candidate.kind === 'build');
      expect(buildCandidate?.candidate.command).toBe('./mvnw verify');
      expect(buildCandidate?.candidate.assertionCapability).toBe('structured');
      expect(candidates.find((c) => c.candidate.kind === 'test')).toBeTruthy();
    });

    it('repo-native test script wins over vitest fallback', async () => {
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

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      // Script enrichment: vitest is recognized and the candidate gets structured
      expect(testCandidate?.candidate.assertionCapability).toBe('structured');
      expect(testCandidate?.candidate.command).toBe('pnpm test');
      expect(testCandidate?.candidate.source).toBe('package.json:scripts.test');
      expect(candidates.find((c) => c.candidate.kind === 'test')?.candidate.confidence).toBe(
        'high',
      );
    });

    it('preserves a filtered repo-native pytest command without full-scope attestation', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: makeDetectedStack([
          { kind: 'testFramework', id: 'pytest', evidence: 'pyproject.toml' },
        ]),
        allFiles: ['package.json', 'pyproject.toml'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { test: 'pytest -c config/ci.ini tests/' } }),
        }),
      });
      const tests = candidates.filter((entry) => entry.candidate.kind === 'test');
      expect(tests).toHaveLength(2);
      expect(tests.map((entry) => entry.candidate.command)).toEqual([
        'npm run test --',
        'npm run test --',
      ]);
      expect(tests[1]!.candidate).toMatchObject({
        assertionCapability: 'structured',
        assertionReport: { format: 'junit_xml' },
      });
      if (tests[1]!.candidate.assertionCapability === 'structured') {
        expect(tests[1]!.candidate.fullCheckScopeAttestation).toBeUndefined();
      }
    });

    it('attests a full repo-native pytest script for its aggregate alternate route', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: makeDetectedStack([
          { kind: 'testFramework', id: 'pytest', evidence: 'pyproject.toml' },
        ]),
        allFiles: ['package.json', 'pyproject.toml'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { test: 'python -m pytest' } }),
        }),
      });
      const aggregate = candidates.find(
        (entry) => entry.executionProfileId === 'pytest-junit-aggregate',
      )?.candidate;

      expect(aggregate).toMatchObject({
        command: 'npm run test --',
        source: 'package.json:scripts.test',
        fullCheckScopeAttestation: 'full_check',
        assertionReport: { format: 'junit_xml' },
      });
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

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate).toBeDefined();
      expect(testCandidate?.candidate.command).toBe('pnpm vitest run');
      expect(testCandidate?.candidate.source).toBe('detectedStack:testFramework:vitest');
      expect(testCandidate?.candidate.confidence).toBe('medium');
    });

    it('prefers Maven wrapper over global Maven', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'maven', evidence: 'pom.xml' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['pom.xml', 'mvnw'],
        readFile: makeReadFile({}),
      });

      const buildCandidate = candidates.find((c) => c.candidate.kind === 'build');
      expect(buildCandidate?.candidate.command).toBe('./mvnw verify');
      expect(candidates.map((c) => c.candidate.command)).not.toContain('mvn verify');
    });

    it('uses Windows Maven wrapper command when only mvnw.cmd exists', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'maven', evidence: 'pom.xml' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['pom.xml', 'mvnw.cmd'],
        readFile: makeReadFile({}),
      });

      const buildCandidate = candidates.find((c) => c.candidate.kind === 'build');
      expect(buildCandidate?.candidate.command).toBe('mvnw.cmd verify');
      expect(candidates.map((c) => c.candidate.command)).not.toContain('mvn verify');
    });

    it('prefers Gradle wrapper over global Gradle', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'gradle', evidence: 'build.gradle' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['build.gradle', 'gradlew'],
        readFile: makeReadFile({}),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.candidate.command).toBe('./gradlew check');
      expect(candidates.map((c) => c.candidate.command)).not.toContain('gradle check');
    });

    it('uses Windows Gradle wrapper command when only gradlew.bat exists', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'gradle', evidence: 'build.gradle' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['build.gradle', 'gradlew.bat'],
        readFile: makeReadFile({}),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.candidate.command).toBe('gradlew.bat check');
      expect(candidates.map((c) => c.candidate.command)).not.toContain('gradle check');
    });

    it('recognizes jest as structured via script enrichment', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'npm', evidence: 'package.json' },
        { kind: 'testFramework', id: 'jest', evidence: 'package.json' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'jest' },
          }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.candidate.assertionCapability).toBe('structured');
      expect(testCandidate?.candidate.command).toBe('npm run test --');
      expect(testCandidate?.candidate.source).toBe('package.json:scripts.test');
      if (testCandidate?.candidate.assertionCapability === 'structured') {
        expect(testCandidate.candidate.assertionReport.format).toBe('jest_json');
      }
    });

    it.each([
      ['pytest', 'full_check'],
      ['python -m pytest', 'full_check'],
      ['pytest tests/test_api.py', undefined],
      ['pytest -k update', undefined],
    ])(
      'attests pytest full check scope only for an exact unfiltered command: %s',
      async (script, attestation) => {
        const candidates = await planVerificationCandidates({
          detectedStack: null,
          allFiles: ['package.json'],
          readFile: makeReadFile({
            'package.json': JSON.stringify({ scripts: { test: script } }),
          }),
        });

        const candidate = candidates.find((entry) => entry.candidate.kind === 'test')?.candidate;
        expect(candidate?.assertionCapability).toBe('structured');
        if (candidate?.assertionCapability === 'structured') {
          expect(candidate.fullCheckScopeAttestation).toBe(attestation);
        }
      },
    );

    it('jest script enrichment requires only signature match, not stack detection', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: null,
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'jest' },
          }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.candidate.assertionCapability).toBe('structured');
      expect(testCandidate?.candidate.command).toBe('npm run test --');
      expect(testCandidate?.candidate.source).toBe('package.json:scripts.test');
      if (testCandidate?.candidate.assertionCapability === 'structured') {
        expect(testCandidate.candidate.assertionReport.format).toBe('jest_json');
      }
    });

    it('vitest script enrichment requires only signature match, not stack detection', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: null,
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'vitest run' },
          }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.candidate.assertionCapability).toBe('structured');
      expect(testCandidate?.candidate.command).toBe('npm run test --');
      expect(testCandidate?.candidate.source).toBe('package.json:scripts.test');
      if (testCandidate?.candidate.assertionCapability === 'structured') {
        expect(testCandidate.candidate.assertionReport.format).toBe('vitest_json');
      }
    });

    it('enriched candidate preserves executionProfileId', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: null,
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'jest' },
          }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.executionProfileId).toBe('jest-fallback');
    });

    it('compound shell command is not enrichable', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: null,
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'vitest && ./cleanup.sh' },
          }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.candidate.assertionCapability).toBe('unsupported');
    });

    it('existing reporter config is not enrichable', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: null,
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'vitest --reporter=junit' },
          }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.candidate.assertionCapability).toBe('unsupported');
    });

    it('unrecognized script remains unsupported', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: null,
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: { test: 'node scripts/custom-test.js' },
          }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      expect(testCandidate?.candidate.assertionCapability).toBe('unsupported');
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

      expect(candidates.find((c) => c.candidate.kind === 'lint')?.candidate.command).toBe(
        'pnpm eslint .',
      );
      expect(candidates.find((c) => c.candidate.kind === 'lint')?.candidate.source).toBe(
        'detectedStack:qualityTool:eslint',
      );
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

      expect(candidates.map((c) => c.candidate.kind)).toEqual([
        'test',
        'test',
        'lint',
        'typecheck',
      ]);
      expect(candidates.map((c) => c.candidate.command)).toEqual([
        'pnpm vitest run',
        'pnpm vitest run',
        'pnpm eslint .',
        'pnpm tsc --noEmit',
      ]);
    });
  });

  describe('provider → planner execution subject wiring', () => {
    it('vitest script enrichment includes vitest config files', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: makeDetectedStack([
          { kind: 'buildTool', id: 'pnpm', evidence: 'pnpm-lock.yaml' },
          { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
        ]),
        allFiles: ['package.json', 'pnpm-lock.yaml', 'vitest.config.ts'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      const inputs = testCandidate?.executionSubjectInputs ?? [];
      expect(inputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'implementation' }),
          expect.objectContaining({ kind: 'file', path: 'package.json' }),
          expect.objectContaining({ kind: 'file', path: 'vitest.config.ts' }),
        ]),
      );
    });

    it('vitest fallback includes vitest config files', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: makeDetectedStack([
          { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
        ]),
        allFiles: ['package.json', 'vitest.config.ts'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { build: 'true' } }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      const inputs = testCandidate?.executionSubjectInputs ?? [];
      expect(inputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'implementation' }),
          expect.objectContaining({ kind: 'file', path: 'vitest.config.ts' }),
        ]),
      );
    });

    it('pytest profile includes config files', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: makeDetectedStack([
          { kind: 'testFramework', id: 'pytest', evidence: 'pyproject.toml' },
        ]),
        allFiles: ['package.json', 'pyproject.toml'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { build: 'true' } }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      const inputs = testCandidate?.executionSubjectInputs ?? [];
      expect(inputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'implementation' }),
          expect.objectContaining({ kind: 'file', path: 'pyproject.toml' }),
        ]),
      );
    });

    it('config files not in rootFiles are absent from subject inputs', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: makeDetectedStack([
          { kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' },
        ]),
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { build: 'true' } }),
        }),
      });

      const testCandidate = candidates.find((c) => c.candidate.kind === 'test');
      const inputs = testCandidate?.executionSubjectInputs ?? [];
      expect(inputs).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ kind: 'file', path: 'vitest.config.ts' }),
        ]),
      );
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

      expect(candidates.find((c) => c.candidate.kind === 'test')?.candidate.command).toBe(
        'pnpm jest',
      );
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

      expect(candidates.find((c) => c.candidate.kind === 'test')?.candidate.command).toBe(
        'npx vitest run',
      );
      expect(candidates.map((c) => c.candidate.command)).not.toContain('npm run test');
    });

    it('ignores single-quote placeholder test script and continues with fallback', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'npm', evidence: 'package.json' },
        { kind: 'testFramework', id: 'jest', evidence: 'jest.config.js' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['package.json', 'jest.config.js'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: {
              test: "echo 'Error: no test specified' && exit 1",
            },
          }),
        }),
      });

      expect(candidates.find((c) => c.candidate.kind === 'test')?.candidate.command).toBe(
        'npx jest',
      );
      expect(candidates.map((c) => c.candidate.command)).not.toContain('npm run test');
    });

    it('ignores placeholder lint and build scripts', async () => {
      const candidates = await planVerificationCandidates({
        detectedStack: null,
        allFiles: ['package.json'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: {
              lint: 'echo TODO && exit 1',
              build: 'echo "not implemented"',
            },
          }),
        }),
      });

      expect(candidates.map((c) => c.candidate.kind)).not.toContain('lint');
      expect(candidates.map((c) => c.candidate.kind)).not.toContain('build');
      expect(candidates).toEqual([]);
    });

    it('does not treat real commands with TODO comments as placeholders', async () => {
      const detectedStack = makeDetectedStack([
        { kind: 'buildTool', id: 'pnpm', evidence: 'pnpm-lock.yaml' },
        { kind: 'qualityTool', id: 'eslint', evidence: 'eslint.config.js' },
      ]);

      const candidates = await planVerificationCandidates({
        detectedStack,
        allFiles: ['package.json', 'pnpm-lock.yaml', 'eslint.config.js'],
        readFile: makeReadFile({
          'package.json': JSON.stringify({
            scripts: {
              lint: 'eslint . # TODO remove legacy ignores',
            },
          }),
        }),
      });

      expect(candidates.find((c) => c.candidate.kind === 'lint')?.candidate.command).toBe(
        'pnpm lint',
      );
      expect(candidates.map((c) => c.candidate.command)).not.toContain('pnpm eslint .');
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
        readFile: makeReadFile({
          'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
        }),
      });
      const elapsedMs = performance.now() - started;

      expect(candidates.find((c) => c.candidate.kind === 'test')?.candidate.command).toBe(
        'pnpm test',
      );
      expect(elapsedMs).toBeLessThan(200);
    });
  });
});
