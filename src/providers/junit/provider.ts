/**
 * @module providers/junit/provider
 * @description JUnit assertion provider extension.
 *
 * Covers both Maven Surefire and Gradle test report paths through two
 * distinct wrapper profiles — both produce junit_xml output parsed by
 * the same parser and codec.
 *
 * @version v1
 */

import { buildJUnitLocalId } from '../../verification/assertion-parsers/junit-xml.js';
import { junitXmlParser } from '../../verification/assertion-parsers/parsers.js';
import type { AssertionProviderExtension } from '../contract.js';
import type { ParsedAssertion } from '../../verification/assertion-parsers/types.js';
import type { ProviderId } from '../../state/assertion-identity.js';
import type { ReportFormatId } from '../../state/assertion-identity.js';

const JUNIT_LOCAL_ID_RE = /^[^#]+#[^#]+$/;

function mavenExecutionSubjectInputs(
  ctx: { rootFiles: ReadonlySet<string> },
  hint?: { matchedExecutable?: string },
) {
  const wrapper =
    hint?.matchedExecutable === 'mvnw.cmd'
      ? 'mvnw.cmd'
      : hint?.matchedExecutable === 'mvnw' || hint?.matchedExecutable === './mvnw'
        ? 'mvnw'
        : ctx.rootFiles.has('mvnw')
          ? 'mvnw'
          : 'mvnw.cmd';
  return [
    ...(ctx.rootFiles.has('pom.xml') ? [{ kind: 'file' as const, path: 'pom.xml' }] : []),
    { kind: 'file' as const, path: wrapper },
  ];
}

function gradleExecutionSubjectInputs(
  ctx: { rootFiles: ReadonlySet<string> },
  hint?: { matchedExecutable?: string },
) {
  const wrapper =
    hint?.matchedExecutable === 'gradlew.bat'
      ? 'gradlew.bat'
      : hint?.matchedExecutable === 'gradlew' || hint?.matchedExecutable === './gradlew'
        ? 'gradlew'
        : ctx.rootFiles.has('gradlew')
          ? 'gradlew'
          : 'gradlew.bat';
  const configurationFiles = [
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.properties',
  ];
  return [
    ...configurationFiles
      .filter((path) => ctx.rootFiles.has(path))
      .map((path) => ({ kind: 'file' as const, path })),
    { kind: 'file' as const, path: wrapper },
  ];
}

function junitCodec() {
  return {
    providerId: 'junit' as ProviderId,
    assertionBindingFormats: new Set<ReportFormatId>(['junit_xml']),
    buildLocalId(parsed: ParsedAssertion) {
      if (parsed.kind !== 'junit_xml') throw new Error(`junit codec received ${parsed.kind}`);
      return buildJUnitLocalId(parsed.className, parsed.methodName);
    },
    validateLocalId(localId: string) {
      return JUNIT_LOCAL_ID_RE.test(localId);
    },
  };
}

function mavenProfile() {
  return {
    profileId: 'junit-maven-wrapper' as const,
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    kind: 'build' as const,
    priority: 0,
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit' as const,
      standardPatterns: ['target/surefire-reports/TEST-*.xml'],
    },
    runtimeRequirements: [
      {
        id: 'java',
        role: 'runtime' as const,
        probe: { kind: 'exec' as const, command: 'java -version' },
      },
      {
        id: 'mvnw',
        role: 'tool' as const,
        probe: { kind: 'executable_file' as const, path: './mvnw' },
      },
    ],
    createCandidate(ctx: { rootFiles: ReadonlySet<string> }) {
      const hasPosix = ctx.rootFiles.has('mvnw');
      const hasWin = ctx.rootFiles.has('mvnw.cmd');
      if (!hasPosix && !hasWin) return null;
      return {
        assertionCapability: 'structured' as const,
        kind: 'build' as const,
        command: hasPosix ? './mvnw verify' : 'mvnw.cmd verify',
        source: hasPosix ? 'repo:mvnw' : 'repo:mvnw.cmd',
        confidence: 'high' as const,
        reason: 'Maven wrapper detected',
        assertionReport: {
          collection: 'snapshot_diff' as const,
          transport: 'file' as const,
          format: 'junit_xml' as const,
          providerId: 'junit' as const,
          standardPatterns: ['target/surefire-reports/TEST-*.xml'],
        },
      };
    },
    resolveExecutionSubjectInputs: mavenExecutionSubjectInputs,
    resolveRuntimeRequirements(candidate: { source: string }) {
      const isWin = candidate.source === 'repo:mvnw.cmd';
      return [
        {
          id: 'java',
          role: 'runtime' as const,
          probe: { kind: 'exec' as const, command: 'java -version' },
        },
        {
          id: 'mvnw',
          role: 'tool' as const,
          probe: { kind: 'executable_file' as const, path: isWin ? 'mvnw.cmd' : './mvnw' },
        },
      ];
    },
  };
}

function gradleProfile() {
  return {
    profileId: 'junit-gradle-wrapper' as const,
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    kind: 'test' as const,
    priority: 1,
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit' as const,
      standardPatterns: ['build/test-results/test/TEST-*.xml'],
    },
    runtimeRequirements: [
      {
        id: 'java',
        role: 'runtime' as const,
        probe: { kind: 'exec' as const, command: 'java -version' },
      },
      {
        id: 'gradlew',
        role: 'tool' as const,
        probe: { kind: 'executable_file' as const, path: './gradlew' },
      },
    ],
    createCandidate(ctx: { rootFiles: ReadonlySet<string> }) {
      const hasPosix = ctx.rootFiles.has('gradlew');
      const hasWin = ctx.rootFiles.has('gradlew.bat');
      if (!hasPosix && !hasWin) return null;
      return {
        assertionCapability: 'structured' as const,
        kind: 'test' as const,
        command: hasPosix ? './gradlew check' : 'gradlew.bat check',
        source: hasPosix ? 'repo:gradlew' : 'repo:gradlew.bat',
        confidence: 'high' as const,
        reason: 'Gradle wrapper detected',
        assertionReport: {
          collection: 'snapshot_diff' as const,
          transport: 'file' as const,
          format: 'junit_xml' as const,
          providerId: 'junit' as const,
          standardPatterns: ['build/test-results/test/TEST-*.xml'],
        },
      };
    },
    resolveExecutionSubjectInputs: gradleExecutionSubjectInputs,
    resolveRuntimeRequirements(candidate: { source: string }) {
      const isWin = candidate.source === 'repo:gradlew.bat';
      return [
        {
          id: 'java',
          role: 'runtime' as const,
          probe: { kind: 'exec' as const, command: 'java -version' },
        },
        {
          id: 'gradlew',
          role: 'tool' as const,
          probe: { kind: 'executable_file' as const, path: isWin ? 'gradlew.bat' : './gradlew' },
        },
      ];
    },
  };
}

function mavenTestProfile() {
  return {
    profileId: 'junit-maven-test' as const,
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    kind: 'test' as const,
    priority: 0,
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit' as const,
      standardPatterns: ['target/surefire-reports/TEST-*.xml'],
    },
    createCandidate(ctx: { rootFiles: ReadonlySet<string> }) {
      const hasPosix = ctx.rootFiles.has('mvnw');
      const hasWin = ctx.rootFiles.has('mvnw.cmd');
      if (!hasPosix && !hasWin) return null;
      return {
        assertionCapability: 'structured' as const,
        kind: 'test' as const,
        command: hasPosix ? './mvnw test' : 'mvnw.cmd test',
        source: hasPosix
          ? 'provider:junit:junit-maven-test'
          : 'provider:junit:junit-maven-test:win',
        confidence: 'high' as const,
        reason: 'JUnit via Maven wrapper (test)',
        assertionReport: {
          collection: 'snapshot_diff' as const,
          transport: 'file' as const,
          format: 'junit_xml' as const,
          providerId: 'junit' as const,
          standardPatterns: ['target/surefire-reports/TEST-*.xml'],
        },
      };
    },
    resolveExecutionSubjectInputs: mavenExecutionSubjectInputs,
  };
}

function mavenVerifyProfile() {
  return {
    profileId: 'junit-maven-verify' as const,
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    kind: 'build' as const,
    priority: 0,
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit' as const,
      standardPatterns: ['target/surefire-reports/TEST-*.xml'],
    },
    createCandidate(ctx: { rootFiles: ReadonlySet<string> }) {
      const hasPosix = ctx.rootFiles.has('mvnw');
      const hasWin = ctx.rootFiles.has('mvnw.cmd');
      if (!hasPosix && !hasWin) return null;
      return {
        assertionCapability: 'structured' as const,
        kind: 'build' as const,
        command: hasPosix ? './mvnw verify' : 'mvnw.cmd verify',
        source: hasPosix
          ? 'provider:junit:junit-maven-verify'
          : 'provider:junit:junit-maven-verify:win',
        confidence: 'high' as const,
        reason: 'JUnit via Maven wrapper (verify, includes tests)',
        assertionReport: {
          collection: 'snapshot_diff' as const,
          transport: 'file' as const,
          format: 'junit_xml' as const,
          providerId: 'junit' as const,
          standardPatterns: ['target/surefire-reports/TEST-*.xml'],
        },
      };
    },
    resolveExecutionSubjectInputs: mavenExecutionSubjectInputs,
  };
}

function gradleTestProfile() {
  return {
    profileId: 'junit-gradle-test' as const,
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    kind: 'test' as const,
    priority: 1,
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit' as const,
      standardPatterns: ['build/test-results/test/TEST-*.xml'],
    },
    createCandidate(ctx: { rootFiles: ReadonlySet<string> }) {
      const hasPosix = ctx.rootFiles.has('gradlew');
      const hasWin = ctx.rootFiles.has('gradlew.bat');
      if (!hasPosix && !hasWin) return null;
      return {
        assertionCapability: 'structured' as const,
        kind: 'test' as const,
        command: hasPosix ? './gradlew test' : 'gradlew.bat test',
        source: hasPosix
          ? 'provider:junit:junit-gradle-test'
          : 'provider:junit:junit-gradle-test:win',
        confidence: 'high' as const,
        reason: 'JUnit via Gradle wrapper (test)',
        assertionReport: {
          collection: 'snapshot_diff' as const,
          transport: 'file' as const,
          format: 'junit_xml' as const,
          providerId: 'junit' as const,
          standardPatterns: ['build/test-results/test/TEST-*.xml'],
        },
      };
    },
    resolveExecutionSubjectInputs: gradleExecutionSubjectInputs,
  };
}

function gradleCheckProfile() {
  return {
    profileId: 'junit-gradle-check' as const,
    providerId: 'junit' as const,
    format: 'junit_xml' as const,
    kind: 'build' as const,
    priority: 1,
    assertionReport: {
      collection: 'snapshot_diff' as const,
      transport: 'file' as const,
      format: 'junit_xml' as const,
      providerId: 'junit' as const,
      standardPatterns: ['build/test-results/test/TEST-*.xml'],
    },
    createCandidate(ctx: { rootFiles: ReadonlySet<string> }) {
      const hasPosix = ctx.rootFiles.has('gradlew');
      const hasWin = ctx.rootFiles.has('gradlew.bat');
      if (!hasPosix && !hasWin) return null;
      return {
        assertionCapability: 'structured' as const,
        kind: 'build' as const,
        command: hasPosix ? './gradlew check' : 'gradlew.bat check',
        source: hasPosix
          ? 'provider:junit:junit-gradle-check'
          : 'provider:junit:junit-gradle-check:win',
        confidence: 'high' as const,
        reason: 'JUnit via Gradle wrapper (check, includes tests)',
        assertionReport: {
          collection: 'snapshot_diff' as const,
          transport: 'file' as const,
          format: 'junit_xml' as const,
          providerId: 'junit' as const,
          standardPatterns: ['build/test-results/test/TEST-*.xml'],
        },
      };
    },
    resolveExecutionSubjectInputs: gradleExecutionSubjectInputs,
  };
}

export const junitProvider: AssertionProviderExtension = {
  manifest: {
    providerId: 'junit' as ProviderId,
    label: 'JUnit',
  },

  discovery: {
    detectionIds: ['testFramework:junit'],
    runtimeRequirements: [
      {
        id: 'java',
        role: 'runtime' as const,
        probe: { kind: 'exec' as const, command: 'java -version' },
      },
    ],
    scriptSignatures: [
      {
        executionProfileId: 'junit-maven-test',
        candidateKind: 'test' as const,
        executable: './mvnw',
        requiredArgsPrefix: ['test'],
      },
      {
        executionProfileId: 'junit-maven-test',
        candidateKind: 'test' as const,
        executable: 'mvnw',
        requiredArgsPrefix: ['test'],
      },
      {
        executionProfileId: 'junit-maven-test',
        candidateKind: 'test' as const,
        executable: 'mvnw.cmd',
        requiredArgsPrefix: ['test'],
      },
      {
        executionProfileId: 'junit-maven-verify',
        candidateKind: 'build' as const,
        executable: './mvnw',
        requiredArgsPrefix: ['verify'],
      },
      {
        executionProfileId: 'junit-maven-verify',
        candidateKind: 'build' as const,
        executable: 'mvnw',
        requiredArgsPrefix: ['verify'],
      },
      {
        executionProfileId: 'junit-maven-verify',
        candidateKind: 'build' as const,
        executable: 'mvnw.cmd',
        requiredArgsPrefix: ['verify'],
      },
      {
        executionProfileId: 'junit-gradle-test',
        candidateKind: 'test' as const,
        executable: './gradlew',
        requiredArgsPrefix: ['test'],
      },
      {
        executionProfileId: 'junit-gradle-test',
        candidateKind: 'test' as const,
        executable: 'gradlew',
        requiredArgsPrefix: ['test'],
      },
      {
        executionProfileId: 'junit-gradle-test',
        candidateKind: 'test' as const,
        executable: 'gradlew.bat',
        requiredArgsPrefix: ['test'],
      },
      {
        executionProfileId: 'junit-gradle-check',
        candidateKind: 'build' as const,
        executable: './gradlew',
        requiredArgsPrefix: ['check'],
      },
      {
        executionProfileId: 'junit-gradle-check',
        candidateKind: 'build' as const,
        executable: 'gradlew',
        requiredArgsPrefix: ['check'],
      },
      {
        executionProfileId: 'junit-gradle-check',
        candidateKind: 'build' as const,
        executable: 'gradlew.bat',
        requiredArgsPrefix: ['check'],
      },
    ],
    executionProfiles: [
      mavenProfile(),
      gradleProfile(),
      mavenTestProfile(),
      mavenVerifyProfile(),
      gradleTestProfile(),
      gradleCheckProfile(),
    ],
  },

  verification: {
    formats: [
      {
        format: 'junit_xml' as ReportFormatId,
        parser: junitXmlParser,
        bindingCapability: 'assertion' as const,
      },
    ],
    identityCodec: junitCodec(),
  },
};
