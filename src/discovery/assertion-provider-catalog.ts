/**
 * @module discovery/assertion-provider-catalog
 * @description Statischer Katalog aller Assertion-Provider und ihrer Execution Profiles.
 *
 * Der Catalog hängt ausschließlich von src/state/ ab — nicht vom Verification-Layer
 * (Parser, Codecs, Registry). Discovery importiert Katalog → Discovery-Intern.
 *
 * @version v2
 */

import type { ProviderId, ReportFormatId } from '../state/assertion-identity.js';
import type { VerificationCandidateKind, AssertionReportSpec } from '../state/discovery-schemas.js';

// ─── Provider Descriptors ────────────────────────────────────────────────────

type DetectionId = `${string}:${string}`;

export type ScriptSignature =
  | {
      readonly executable: string;
      readonly requiredArgsPrefix?: readonly string[];
    }
  | {
      readonly moduleInvocation: {
        readonly executable: string;
        readonly module: string;
      };
    };

export interface RuntimeRequirement {
  readonly id: string;
  readonly role: 'runtime' | 'tool' | 'reporter';
  readonly probe: {
    readonly command: string;
    readonly versionPattern?: string;
  };
}

export interface AssertionProviderDescriptor {
  readonly providerId: ProviderId;
  readonly label: string;
  /** Detection-IDs aus DetectedStack.items, die diesen Provider identifizieren. */
  readonly detectionIds: readonly DetectionId[];
  /** Format, das assertion-level binding unterstützt. */
  readonly preferredAssertionFormat: ReportFormatId;

  /** Script signatures for provider-aware script enrichment (PR 8). */
  readonly scriptSignatures?: readonly ScriptSignature[];
  /** Declarative runtime requirements for toolchain probing (PR 8). */
  readonly runtimeRequirements?: readonly RuntimeRequirement[];
  /** Immutable report template — {attemptId} resolved by prepareVerificationExecution(). */
  readonly assertionReportTemplate?: AssertionReportSpec;
}

export const PROVIDER_DESCRIPTORS: readonly AssertionProviderDescriptor[] = [
  {
    providerId: 'junit',
    label: 'JUnit',
    detectionIds: ['testFramework:junit'],
    preferredAssertionFormat: 'junit_xml',
    runtimeRequirements: [
      {
        id: 'java',
        role: 'runtime',
        probe: { command: 'java -version' },
      },
    ],
  },
  {
    providerId: 'vitest',
    label: 'Vitest',
    detectionIds: ['testFramework:vitest'],
    preferredAssertionFormat: 'vitest_json',
    scriptSignatures: [{ executable: 'vitest' }],
    runtimeRequirements: [
      {
        id: 'vitest',
        role: 'tool',
        probe: { command: 'node_modules/.bin/vitest --version' },
      },
    ],
    assertionReportTemplate: {
      collection: 'run_specific' as const,
      transport: 'file' as const,
      format: 'vitest_json' as const,
      providerId: 'vitest' as const,
      outputArgumentTemplate:
        '--reporter=json --outputFile=.flowguard/reports/{attemptId}/vitest.json',
      resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.json',
    },
  },
  {
    providerId: 'jest',
    label: 'Jest',
    detectionIds: ['testFramework:jest'],
    preferredAssertionFormat: 'jest_json',
    scriptSignatures: [{ executable: 'jest' }],
    runtimeRequirements: [
      {
        id: 'jest',
        role: 'tool',
        probe: { command: 'node_modules/.bin/jest --version' },
      },
    ],
    assertionReportTemplate: {
      collection: 'run_specific' as const,
      transport: 'file' as const,
      format: 'jest_json' as const,
      providerId: 'jest' as const,
      outputArgumentTemplate: '--json --outputFile=.flowguard/reports/{attemptId}/jest.json',
      resultPatternTemplate: '.flowguard/reports/{attemptId}/jest.json',
    },
  },
  {
    providerId: 'pytest',
    label: 'pytest',
    detectionIds: ['testFramework:pytest'],
    preferredAssertionFormat: 'pytest_json',
    scriptSignatures: [
      { executable: 'pytest' },
      {
        moduleInvocation: { executable: 'python', module: 'pytest' },
      },
    ],
    runtimeRequirements: [
      {
        id: 'python',
        role: 'runtime',
        probe: { command: 'python --version' },
      },
      {
        id: 'pytest',
        role: 'tool',
        probe: { command: 'python -c "import pytest"' },
      },
      {
        id: 'pytest-json-report',
        role: 'reporter',
        probe: { command: 'python -c "import pytest_jsonreport"' },
      },
    ],
    assertionReportTemplate: {
      collection: 'run_specific' as const,
      transport: 'file' as const,
      format: 'pytest_json' as const,
      providerId: 'pytest' as const,
      outputArgumentTemplate:
        '--json-report --json-report-file=.flowguard/reports/{attemptId}/pytest.json',
      resultPatternTemplate: '.flowguard/reports/{attemptId}/pytest.json',
    },
  },
  {
    providerId: 'go_test',
    label: 'Go test',
    detectionIds: ['testFramework:go_test', 'language:go'],
    preferredAssertionFormat: 'go_test_json',
    scriptSignatures: [{ executable: 'go', requiredArgsPrefix: ['test'] }],
    runtimeRequirements: [
      {
        id: 'go',
        role: 'tool',
        probe: { command: 'go version' },
      },
    ],
    assertionReportTemplate: {
      collection: 'stdout' as const,
      transport: 'stdout' as const,
      format: 'go_test_json' as const,
      providerId: 'go_test' as const,
    },
  },
];

export const DESCRIPTOR_BY_PROVIDER: ReadonlyMap<ProviderId, AssertionProviderDescriptor> = new Map(
  PROVIDER_DESCRIPTORS.map((d) => [d.providerId, d]),
);

// ─── Planner Context ─────────────────────────────────────────────────────────

export interface PlannerContext {
  readonly rootFiles: ReadonlySet<string>;
  readonly packageManager: string;
  readonly detectedStackIds: ReadonlySet<string>;
}

// ─── Execution Profiles ──────────────────────────────────────────────────────

export interface ExecutionProfile {
  readonly profileId: string;
  readonly providerId: ProviderId;
  readonly format: ReportFormatId;
  readonly kind: VerificationCandidateKind;

  /** Liefert einen Candidate nur mit ausreichender Evidence, sonst null. */
  createCandidate(
    ctx: PlannerContext,
  ): import('../state/discovery-schemas.js').VerificationCandidate | null;

  /** Profile-specific runtime requirements override provider defaults (PR 8). */
  readonly runtimeRequirements?: readonly RuntimeRequirement[];
}

// ─── Implementation Helpers ──────────────────────────────────────────────────

function fallbackCmd(pm: string, cmd: string): string {
  if (pm === 'pnpm') return `pnpm ${cmd}`;
  if (pm === 'yarn') return `yarn ${cmd}`;
  if (pm === 'bun') return `bunx ${cmd}`;
  return `npx ${cmd}`;
}

// ─── ALLE Execution Profiles ─────────────────────────────────────────────────

/**
 * JUnit Maven Wrapper — ./mvnw test (Surefire XML)
 */
const jUnitMavenWrapperProfile: ExecutionProfile = {
  profileId: 'junit-maven-wrapper',
  providerId: 'junit',
  format: 'junit_xml',
  kind: 'build',
  runtimeRequirements: [
    {
      id: 'java',
      role: 'runtime',
      probe: { command: 'java -version' },
    },
    {
      id: 'mvnw',
      role: 'tool',
      probe: { command: 'test -x ./mvnw' },
    },
  ],
  createCandidate(ctx) {
    const hasPosix = ctx.rootFiles.has('mvnw');
    const hasWin = ctx.rootFiles.has('mvnw.cmd');
    if (!hasPosix && !hasWin) return null;
    return {
      assertionCapability: 'structured' as const,
      kind: 'build',
      command: hasPosix ? './mvnw verify' : 'mvnw.cmd verify',
      source: hasPosix ? 'repo:mvnw' : 'repo:mvnw.cmd',
      confidence: 'high',
      reason: 'Maven wrapper detected; wrapper command is preferred over global Maven binary',
      assertionReport: {
        collection: 'snapshot_diff' as const,
        transport: 'file' as const,
        format: 'junit_xml' as const,
        providerId: 'junit' as const,
        standardPatterns: ['target/surefire-reports/TEST-*.xml'],
      },
    };
  },
};

/**
 * JUnit Gradle Wrapper — ./gradlew test (XML reports)
 */
const jUnitGradleWrapperProfile: ExecutionProfile = {
  profileId: 'junit-gradle-wrapper',
  providerId: 'junit',
  format: 'junit_xml',
  kind: 'test',
  runtimeRequirements: [
    {
      id: 'java',
      role: 'runtime',
      probe: { command: 'java -version' },
    },
    {
      id: 'gradlew',
      role: 'tool',
      probe: { command: 'test -x ./gradlew' },
    },
  ],
  createCandidate(ctx) {
    const hasPosix = ctx.rootFiles.has('gradlew');
    const hasWin = ctx.rootFiles.has('gradlew.bat');
    if (!hasPosix && !hasWin) return null;
    return {
      assertionCapability: 'structured' as const,
      kind: 'test',
      command: hasPosix ? './gradlew check' : 'gradlew.bat check',
      source: hasPosix ? 'repo:gradlew' : 'repo:gradlew.bat',
      confidence: 'high',
      reason: 'Gradle wrapper detected; wrapper command is preferred over global Gradle binary',
      assertionReport: {
        collection: 'snapshot_diff' as const,
        transport: 'file' as const,
        format: 'junit_xml' as const,
        providerId: 'junit' as const,
        standardPatterns: ['build/test-results/test/TEST-*.xml'],
      },
    };
  },
};

/**
 * Vitest Fallback — npx vitest run (JSON reporter)
 */
const vitestFallbackProfile: ExecutionProfile = {
  profileId: 'vitest-fallback',
  providerId: 'vitest',
  format: 'vitest_json',
  kind: 'test',
  createCandidate(ctx) {
    if (!ctx.detectedStackIds.has('testFramework:vitest')) return null;
    const pm = ctx.packageManager;
    return {
      assertionCapability: 'structured' as const,
      kind: 'test',
      command: fallbackCmd(pm, 'vitest run'),
      source: 'detectedStack:testFramework:vitest',
      confidence: 'medium',
      reason: `Vitest detected and no repo-native test script found; using ${pm} fallback`,
      assertionReport: {
        collection: 'run_specific' as const,
        transport: 'file' as const,
        format: 'vitest_json' as const,
        providerId: 'vitest' as const,
        outputArgumentTemplate:
          '--reporter=json --outputFile=.flowguard/reports/{attemptId}/vitest.json',
        resultPatternTemplate: '.flowguard/reports/{attemptId}/vitest.json',
      },
    };
  },
};

/**
 * Jest Fallback — npx jest (JSON reporter)
 */
const jestFallbackProfile: ExecutionProfile = {
  profileId: 'jest-fallback',
  providerId: 'jest',
  format: 'jest_json',
  kind: 'test',
  createCandidate(ctx) {
    if (!ctx.detectedStackIds.has('testFramework:jest')) return null;
    const pm = ctx.packageManager;
    return {
      assertionCapability: 'structured' as const,
      kind: 'test',
      command: fallbackCmd(pm, 'jest'),
      source: 'detectedStack:testFramework:jest',
      confidence: 'medium',
      reason: `Jest detected and no repo-native test script found; using ${pm} fallback`,
      assertionReport: {
        collection: 'run_specific' as const,
        transport: 'file' as const,
        format: 'jest_json' as const,
        providerId: 'jest' as const,
        outputArgumentTemplate: '--json --outputFile=.flowguard/reports/{attemptId}/jest.json',
        resultPatternTemplate: '.flowguard/reports/{attemptId}/jest.json',
      },
    };
  },
};

/**
 * pytest JSON Fallback — python -m pytest --json-report
 */
const pytestJsonProfile: ExecutionProfile = {
  profileId: 'pytest-json-fallback',
  providerId: 'pytest',
  format: 'pytest_json',
  kind: 'test',
  createCandidate(ctx) {
    if (!ctx.detectedStackIds.has('testFramework:pytest')) return null;
    return {
      assertionCapability: 'structured' as const,
      kind: 'test',
      command: 'python -m pytest',
      source: 'detectedStack:testFramework:pytest',
      confidence: 'medium',
      reason: 'pytest detected; using structured JSON assertion extraction',
      assertionReport: {
        collection: 'run_specific' as const,
        transport: 'file' as const,
        format: 'pytest_json' as const,
        providerId: 'pytest' as const,
        outputArgumentTemplate:
          '--json-report --json-report-file=.flowguard/reports/{attemptId}/pytest.json',
        resultPatternTemplate: '.flowguard/reports/{attemptId}/pytest.json',
      },
    };
  },
};

/**
 * Go test stdout — go test -json ./... (stdout-basiert)
 */
const goTestStdoutProfile: ExecutionProfile = {
  profileId: 'go-test-stdout',
  providerId: 'go_test',
  format: 'go_test_json',
  kind: 'test',
  createCandidate(ctx) {
    if (!ctx.detectedStackIds.has('testFramework:go_test')) return null;
    return {
      assertionCapability: 'structured' as const,
      kind: 'test',
      command: 'go test -json ./...',
      source: 'detectedStack:testFramework:go_test',
      confidence: 'medium',
      reason: 'Go toolchain detected; using go test -json for structured assertion extraction',
      assertionReport: {
        collection: 'stdout' as const,
        transport: 'stdout' as const,
        format: 'go_test_json' as const,
        providerId: 'go_test' as const,
      },
    };
  },
};

// ─── Profile Directory ───────────────────────────────────────────────────────

/** Alle Execution Profiles in Planner-Präzedenz-Reihenfolge. */
export const ASSERTION_PROFILES: readonly ExecutionProfile[] = [
  jUnitMavenWrapperProfile,
  jUnitGradleWrapperProfile,
  vitestFallbackProfile,
  jestFallbackProfile,
  pytestJsonProfile,
  goTestStdoutProfile,
];

/** Detection-ID → Deskriptor-Lookup. */
export const DESCRIPTOR_BY_DETECTION: ReadonlyMap<DetectionId, AssertionProviderDescriptor> =
  new Map(
    PROVIDER_DESCRIPTORS.flatMap((desc) =>
      desc.detectionIds.map((detId) => [detId, desc] as const),
    ),
  );

/** Wrapper-Profile (root-file-based, before fallbacks). */
export const WRAPPER_PROFILES: readonly ExecutionProfile[] = [
  jUnitMavenWrapperProfile,
  jUnitGradleWrapperProfile,
];

/** Fallback-Profile (detected-stack-based, after wrappers). */
export const FALLBACK_PROFILES: readonly ExecutionProfile[] = [
  vitestFallbackProfile,
  jestFallbackProfile,
  pytestJsonProfile,
  goTestStdoutProfile,
];
