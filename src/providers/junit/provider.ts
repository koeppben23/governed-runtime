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
import { classifyRepositoryPath } from '../../state/repository-path.js';
import type {
  AssertionProviderExtension,
  ExecutionSubjectResolution,
  ExecutionSubjectResolutionHint,
  PlannerContext,
} from '../contract.js';
import type { ParsedAssertion } from '../../verification/assertion-parsers/types.js';
import type { ProviderId } from '../../state/assertion-identity.js';
import type { ReportFormatId } from '../../state/assertion-identity.js';
import type { ExecutionSubjectInput } from '../../state/discovery-schemas.js';

const JUNIT_LOCAL_ID_RE = /^[^#]+#[^#]+$/;
const MAVEN_WRAPPER_BOOTSTRAP_FILES = [
  '.mvn/wrapper/maven-wrapper.properties',
  '.mvn/wrapper/maven-wrapper.jar',
  '.mvn/wrapper/MavenWrapperDownloader.java',
];
const MAVEN_RUNTIME_CONFIG_FILES = ['.mvn/maven.config', '.mvn/jvm.config', '.mvn/extensions.xml'];
const GRADLE_WRAPPER_BOOTSTRAP_FILES = [
  'gradle/wrapper/gradle-wrapper.properties',
  'gradle/wrapper/gradle-wrapper.jar',
];

type MavenConfigSelection =
  | {
      readonly kind: 'resolved';
      readonly inputs: readonly ExecutionSubjectInput[];
      readonly pomPaths: readonly string[];
    }
  | { readonly kind: 'blocked'; readonly reason: string };

async function mavenExecutionSubjectInputs(
  ctx: PlannerContext,
  hint?: ExecutionSubjectResolutionHint,
): Promise<ExecutionSubjectResolution> {
  const wrapper =
    hint?.matchedExecutable === 'mvnw.cmd'
      ? 'mvnw.cmd'
      : hint?.matchedExecutable === 'mvnw' || hint?.matchedExecutable === './mvnw'
        ? 'mvnw'
        : ctx.rootFiles.has('mvnw')
          ? 'mvnw'
          : 'mvnw.cmd';
  const selectedFiles = await mavenConfigSelectedFiles(ctx);
  if (selectedFiles.kind === 'blocked') return selectedFiles;
  const pomGraph = await mavenPomGraphInputs(ctx, [
    ...(ctx.rootFiles.has('pom.xml') ? ['pom.xml'] : []),
    ...selectedFiles.pomPaths,
  ]);
  if (pomGraph.kind === 'blocked') return pomGraph;
  return {
    kind: 'resolved',
    inputs: [
      ...pomGraph.inputs,
      ...existingFiles(ctx, MAVEN_RUNTIME_CONFIG_FILES),
      ...selectedFiles.inputs,
      ...existingFiles(ctx, MAVEN_WRAPPER_BOOTSTRAP_FILES),
      { kind: 'file' as const, path: wrapper },
    ],
  };
}

function gradleExecutionSubjectInputs(
  ctx: PlannerContext,
  hint?: ExecutionSubjectResolutionHint,
): ExecutionSubjectResolution {
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
  return {
    kind: 'resolved',
    inputs: [
      ...configurationFiles
        .filter((path) => ctx.rootFiles.has(path))
        .map((path) => ({ kind: 'file' as const, path })),
      ...existingFiles(ctx, GRADLE_WRAPPER_BOOTSTRAP_FILES),
      { kind: 'file' as const, path: wrapper },
    ],
  };
}

function existingFiles(ctx: PlannerContext, paths: readonly string[]) {
  const allFiles = new Set(ctx.allFiles ?? []);
  return paths
    .filter((path) => allFiles.has(path))
    .map((path) => ({ kind: 'file' as const, path }));
}

const MAVEN_FILE_SELECTORS = new Set([
  '-f',
  '--file',
  '-s',
  '--settings',
  '-gs',
  '--global-settings',
  '-t',
  '--toolchains',
]);
const MAVEN_SHORT_FILE_SELECTORS = ['-gs', '-f', '-s', '-t'] as const;

async function mavenConfigSelectedFiles(ctx: PlannerContext): Promise<MavenConfigSelection> {
  const config = await ctx.readFile('.mvn/maven.config');
  if (!config) return { kind: 'resolved', inputs: [], pomPaths: [] };

  const allFiles = new Set(ctx.allFiles ?? []);
  const tokens = config.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const inputs: ExecutionSubjectInput[] = [];
  const pomPaths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const [parsedOption = '', inlineValue] = token.split('=', 2);
    const shortOption = MAVEN_SHORT_FILE_SELECTORS.find(
      (candidate) =>
        parsedOption !== candidate &&
        parsedOption.startsWith(candidate) &&
        parsedOption.length > candidate.length,
    );
    const option = MAVEN_FILE_SELECTORS.has(parsedOption) ? parsedOption : shortOption;
    if (!option) continue;
    const value =
      inlineValue ?? (shortOption ? parsedOption.slice(shortOption.length) : tokens[++index]);
    if (!value)
      return { kind: 'blocked', reason: `Maven config selector '${option}' has no value` };
    const path = value.replace(/^(?:"|')|(?:"|')$/g, '').replace(/^\.\//, '');
    if (path.startsWith('/') || path.split('/').includes('..') || !allFiles.has(path)) {
      return { kind: 'blocked', reason: `Maven config selector '${option}' is not repo-local` };
    }
    inputs.push({ kind: 'file', path });
    if (option === '-f' || option === '--file') pomPaths.push(path);
  }
  return { kind: 'resolved', inputs, pomPaths };
}

async function mavenPomGraphInputs(
  ctx: PlannerContext,
  startingPoms: readonly string[],
): Promise<ExecutionSubjectResolution> {
  const allFiles = new Set(ctx.allFiles ?? []);
  const pending = [...new Set(startingPoms)];
  const visited = new Set<string>();
  const inputs: ExecutionSubjectInput[] = [];

  while (pending.length > 0) {
    const pomPath = pending.pop()!;
    if (visited.has(pomPath)) continue;
    if (!allFiles.has(pomPath)) {
      return { kind: 'blocked', reason: `Maven POM '${pomPath}' is not repo-local` };
    }
    const content = await ctx.readFile(pomPath);
    if (content === undefined) {
      return { kind: 'blocked', reason: `Maven POM '${pomPath}' cannot be read` };
    }

    visited.add(pomPath);
    inputs.push({ kind: 'file', path: pomPath });
    const references = mavenPomReferences(content);
    for (const reference of references) {
      const resolved = resolveMavenPomReference(pomPath, reference, allFiles);
      if (resolved.kind === 'blocked') return resolved;
      pending.push(resolved.path);
    }
  }

  return { kind: 'resolved', inputs };
}

interface MavenPomReference {
  readonly kind: 'module' | 'parent';
  readonly value: string;
}

function mavenPomReferences(content: string): MavenPomReference[] {
  const references: MavenPomReference[] = [];
  for (const match of content.matchAll(/<module(?:\s[^>]*)?>([\s\S]*?)<\/module>/gi)) {
    references.push({ kind: 'module', value: xmlText(match[1] ?? '') });
  }
  for (const parent of content.matchAll(/<parent(?:\s[^>]*)?>([\s\S]*?)<\/parent>/gi)) {
    const relativePath = parent[1]?.match(/<relativePath(?:\s[^>]*)?>([\s\S]*?)<\/relativePath>/i);
    if (relativePath) {
      const value = xmlText(relativePath[1] ?? '');
      if (value.length > 0) references.push({ kind: 'parent', value });
    } else {
      references.push({ kind: 'parent', value: '../pom.xml' });
    }
  }
  return references;
}

function xmlText(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

type MavenPomReferenceResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'blocked'; readonly reason: string };

function resolveMavenPomReference(
  currentPom: string,
  reference: MavenPomReference,
  allFiles: ReadonlySet<string>,
): MavenPomReferenceResolution {
  const currentDirectory = currentPom.includes('/')
    ? currentPom.slice(0, currentPom.lastIndexOf('/'))
    : '';
  const rawPath = currentDirectory ? `${currentDirectory}/${reference.value}` : reference.value;
  const classified = classifyRepositoryPath(rawPath);
  if (classified.kind !== 'valid') {
    return { kind: 'blocked', reason: `Maven ${reference.kind} path is not repo-local` };
  }
  const path =
    reference.kind === 'module' && !allFiles.has(classified.normalizedPath)
      ? `${classified.normalizedPath}/pom.xml`
      : classified.normalizedPath;
  if (!allFiles.has(path)) {
    return { kind: 'blocked', reason: `Maven ${reference.kind} POM '${path}' is not repo-local` };
  }
  return { kind: 'resolved', path };
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
