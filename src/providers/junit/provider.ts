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

import { buildJUnitLocalId } from '../assertion-parsers/junit-xml.js';
import { junitXmlParser } from '../assertion-parsers/parsers.js';
import { ProviderError } from '../errors.js';
import type { AssertionProviderExtension } from '../contract.js';
import type { ParsedAssertion } from '../assertion-parsers/types.js';
import type { ProviderId } from '../../state/assertion-identity.js';
import type { ReportFormatId } from '../../state/assertion-identity.js';
import {
  gradleCheckProfile,
  gradleProfile,
  gradleTestProfile,
  mavenProfile,
  mavenTestProfile,
  mavenVerifyProfile,
} from './profiles.js';

const JUNIT_LOCAL_ID_RE = /^[^#]+#[^#]+$/;

function junitCodec() {
  return {
    providerId: 'junit' as ProviderId,
    assertionBindingFormats: new Set<ReportFormatId>(['junit_xml']),
    buildLocalId(parsed: ParsedAssertion) {
      if (parsed.kind !== 'junit_xml')
        throw new ProviderError(
          'PROVIDER_CODEC_KIND_MISMATCH',
          `junit codec received ${parsed.kind}`,
        );
      return buildJUnitLocalId(parsed.className, parsed.methodName);
    },
    validateLocalId(localId: string) {
      return JUNIT_LOCAL_ID_RE.test(localId);
    },
  };
}

export const junitProvider: AssertionProviderExtension = {
  manifest: {
    providerId: 'junit',
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
        format: 'junit_xml',
        parser: junitXmlParser,
        bindingCapability: 'assertion' as const,
      },
    ],
    identityCodec: junitCodec(),
  },
};
