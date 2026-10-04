/**
 * @module providers/junit/execution-subject
 * @description Maven and Gradle execution-subject resolution for the JUnit provider.
 *
 * Resolves the repository-local files (POM graph, Maven/Gradle configuration
 * and wrapper bootstrap files) that bind a JUnit candidate to its execution
 * subject.
 *
 * @version v1
 */

import { classifyRepositoryPath } from '../../state/repository-path.js';
import type {
  ExecutionSubjectResolution,
  ExecutionSubjectResolutionHint,
  PlannerContext,
} from '../contract.js';
import type { ExecutionSubjectInput } from '../../state/discovery-schemas.js';

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

export async function mavenExecutionSubjectInputs(
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

export async function gradleExecutionSubjectInputs(
  ctx: PlannerContext,
  hint?: ExecutionSubjectResolutionHint,
): Promise<ExecutionSubjectResolution> {
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
  for (const settingsPath of ['settings.gradle', 'settings.gradle.kts']) {
    if (!ctx.rootFiles.has(settingsPath)) continue;
    const settings = await ctx.readFile(settingsPath);
    if (settings === undefined || !isSupportedSingleProjectSettings(settings)) {
      return { kind: 'blocked', reason: 'Gradle settings graph is unsupported' };
    }
  }
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
const GRADLE_SINGLE_PROJECT_SETTINGS_RE =
  /^\s*(?:rootProject\.name\s*=\s*(?:'[^']*'|"[^"]*")\s*;?\s*)?$/;

function isSupportedSingleProjectSettings(settings: string): boolean {
  const withoutComments = settings.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return GRADLE_SINGLE_PROJECT_SETTINGS_RE.test(withoutComments);
}

function selectMavenFileOption(
  parsedOption: string,
  shortOption: string | undefined,
): string | undefined {
  return MAVEN_FILE_SELECTORS.has(parsedOption) ? parsedOption : shortOption;
}

type MavenTokenSelection =
  | { readonly kind: 'skip' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | {
      readonly kind: 'selected';
      readonly input: ExecutionSubjectInput;
      readonly pomPath: string | null;
      readonly consumedNextToken: boolean;
    };

function normalizeMavenConfigPath(value: string): string | null {
  const path = value.replace(/^(?:"|')|(?:"|')$/g, '').replace(/^\.\//, '');
  if (path.startsWith('/') || path.split('/').includes('..')) return null;
  return path;
}

function selectMavenConfigToken(
  tokens: readonly string[],
  index: number,
  allFiles: ReadonlySet<string>,
): MavenTokenSelection {
  const token = tokens[index];
  if (token === undefined) return { kind: 'skip' };
  const [parsedOption = '', inlineValue] = token.split('=', 2);
  const shortOption = MAVEN_SHORT_FILE_SELECTORS.find(
    (candidate) =>
      parsedOption !== candidate &&
      parsedOption.startsWith(candidate) &&
      parsedOption.length > candidate.length,
  );
  const option = selectMavenFileOption(parsedOption, shortOption);
  if (!option) return { kind: 'skip' };
  const consumedNextToken = inlineValue === undefined && shortOption === undefined;
  const value =
    inlineValue ?? (shortOption ? parsedOption.slice(shortOption.length) : tokens[index + 1]);
  if (!value) {
    return { kind: 'blocked', reason: `Maven config selector '${option}' has no value` };
  }
  const path = normalizeMavenConfigPath(value);
  if (path === null || !allFiles.has(path)) {
    return { kind: 'blocked', reason: `Maven config selector '${option}' is not repo-local` };
  }
  return {
    kind: 'selected',
    input: { kind: 'file', path },
    pomPath: option === '-f' || option === '--file' ? path : null,
    consumedNextToken,
  };
}

async function mavenConfigSelectedFiles(ctx: PlannerContext): Promise<MavenConfigSelection> {
  const config = await ctx.readFile('.mvn/maven.config');
  if (!config) return { kind: 'resolved', inputs: [], pomPaths: [] };

  const allFiles = new Set(ctx.allFiles ?? []);
  const tokens = config.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const inputs: ExecutionSubjectInput[] = [];
  const pomPaths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const selection = selectMavenConfigToken(tokens, index, allFiles);
    if (selection.kind === 'blocked') return selection;
    if (selection.kind !== 'selected') continue;
    inputs.push(selection.input);
    if (selection.pomPath !== null) pomPaths.push(selection.pomPath);
    if (selection.consumedNextToken) index += 1;
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
    const pomPath = pending.pop();
    if (pomPath === undefined) break;
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
    const emptyRelativePath = /<relativePath(?:\s[^>]*)?\s*\/>/i.test(parent[1] ?? '');
    if (relativePath) {
      const value = xmlText(relativePath[1] ?? '');
      if (value.length > 0) references.push({ kind: 'parent', value });
    } else if (!emptyRelativePath) {
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
