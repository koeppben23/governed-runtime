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

import {
  parseJUnitXml,
  buildJUnitLocalId,
} from '../../verification/assertion-parsers/junit-xml.js';
import type { AssertionProviderExtension } from '../contract.js';
import type { ParsedAssertion } from '../../verification/assertion-parsers/types.js';
import type { ProviderId } from '../../state/assertion-identity.js';
import type { ReportFormatId } from '../../state/assertion-identity.js';

const JUNIT_LOCAL_ID_RE = /^[^#]+#[^#]+$/;

function junitParser() {
  return {
    format: 'junit_xml' as ReportFormatId,
    parse(content: string, fileName: string, context: { providerId: string }) {
      return parseJUnitXml(content, fileName, context);
    },
  };
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
    executionProfiles: [mavenProfile(), gradleProfile()],
  },

  verification: {
    formats: [
      {
        format: 'junit_xml' as ReportFormatId,
        parser: junitParser(),
        bindingCapability: 'assertion' as const,
      },
    ],
    identityCodec: junitCodec(),
  },
};
