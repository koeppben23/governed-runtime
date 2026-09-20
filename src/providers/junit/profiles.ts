/**
 * @module providers/junit/profiles
 * @description Execution profiles for the JUnit assertion provider.
 *
 * Maven Surefire and Gradle wrapper profiles in test and build variants.
 *
 * @version v1
 */

import { gradleExecutionSubjectInputs, mavenExecutionSubjectInputs } from './execution-subject.js';

export function mavenProfile() {
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

export function gradleProfile() {
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

export function mavenTestProfile() {
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

export function mavenVerifyProfile() {
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

export function gradleTestProfile() {
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

export function gradleCheckProfile() {
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
