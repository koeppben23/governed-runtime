/**
 * @module discovery/verification-planner
 * @description Advisory verification command planner.
 *
 * Derives evidence-backed, repo-native verification command candidates from:
 * - detected stack items (tool/framework/package-manager evidence)
 * - root package.json scripts
 * - root Java wrapper files (mvnw/gradlew)
 *
 * Planner only: it never executes commands.
 */

import type { DetectedStack, VerificationCandidate, VerificationCandidateKind } from './types';

type ReadFileFn = (relativePath: string) => Promise<string | undefined>;

interface VerificationPlannerInput {
  readonly detectedStack: DetectedStack | null | undefined;
  readonly allFiles: readonly string[];
  readonly readFile: ReadFileFn;
}

type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

const KIND_ORDER: Record<VerificationCandidateKind, number> = {
  build: 0,
  test: 1,
  lint: 2,
  typecheck: 3,
  format: 4,
  security: 5,
  coverage: 6,
};

const BUILD_TOOL_PM_ORDER: readonly PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];

/**
 * Plan advisory verification candidates using repo-first precedence:
 * 1) package.json scripts
 * 2) wrapper commands (mvnw/gradlew)
 * 3) tool defaults from detected stack
 */
export async function planVerificationCandidates(
  input: VerificationPlannerInput,
): Promise<VerificationCandidate[]> {
  const byKind = new Map<VerificationCandidateKind, VerificationCandidate>();
  const rootFiles = new Set(input.allFiles.filter((f) => !f.includes('/') && !f.includes('\\')));
  const packageManager = detectPackageManager(input.detectedStack, rootFiles);

  const scripts = await readPackageScripts(input.readFile);
  addScriptCandidates(byKind, scripts, packageManager);

  addWrapperCandidates(byKind, rootFiles);
  addFallbackCandidates(byKind, input.detectedStack, packageManager);

  return [...byKind.values()].sort((a, b) => {
    const orderDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (orderDiff !== 0) return orderDiff;
    return a.command.localeCompare(b.command);
  });
}

function detectPackageManager(
  detectedStack: DetectedStack | null | undefined,
  rootFiles: ReadonlySet<string>,
): PackageManager {
  const buildToolIds = new Set(
    (detectedStack?.items ?? []).filter((item) => item.kind === 'buildTool').map((item) => item.id),
  );

  for (const pm of BUILD_TOOL_PM_ORDER) {
    if (buildToolIds.has(pm)) return pm;
  }

  if (rootFiles.has('pnpm-lock.yaml')) return 'pnpm';
  if (rootFiles.has('yarn.lock')) return 'yarn';
  if (rootFiles.has('bun.lock') || rootFiles.has('bun.lockb')) return 'bun';
  return 'npm';
}

function addCandidate(
  byKind: Map<VerificationCandidateKind, VerificationCandidate>,
  candidate: VerificationCandidate,
): void {
  if (byKind.has(candidate.kind)) return;
  byKind.set(candidate.kind, candidate);
}

async function readPackageScripts(readFile: ReadFileFn): Promise<Record<string, string>> {
  const content = await readFile('package.json');
  if (!content) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object') return {};
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') return {};

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      result[key] = value;
    }
  }
  return result;
}

function scriptCommand(packageManager: PackageManager, scriptName: string): string {
  if (packageManager === 'npm') return `npm run ${scriptName}`;
  if (packageManager === 'bun') return `bun run ${scriptName}`;
  return `${packageManager} ${scriptName}`;
}

function addScriptCandidates(
  byKind: Map<VerificationCandidateKind, VerificationCandidate>,
  scripts: Record<string, string>,
  packageManager: PackageManager,
): void {
  const mappings: Array<{ kind: VerificationCandidateKind; script: string }> = [
    { kind: 'test', script: 'test' },
    { kind: 'lint', script: 'lint' },
    { kind: 'typecheck', script: 'typecheck' },
    { kind: 'build', script: 'build' },
    { kind: 'format', script: 'format' },
    { kind: 'coverage', script: 'coverage' },
    { kind: 'coverage', script: 'test:coverage' },
    { kind: 'security', script: 'security' },
    { kind: 'security', script: 'audit' },
  ];

  for (const mapping of mappings) {
    if (!(mapping.script in scripts)) continue;
    if (mapping.script === 'test' && isLikelyPlaceholderTestScript(scripts[mapping.script]!)) {
      continue;
    }
    addCandidate(byKind, {
      kind: mapping.kind,
      command: scriptCommand(packageManager, mapping.script),
      source: `package.json:scripts.${mapping.script}`,
      confidence: 'high',
      reason: `Repo-native ${mapping.script} script detected and ${packageManager} package manager detected`,
    });
  }
}

function addWrapperCandidates(
  byKind: Map<VerificationCandidateKind, VerificationCandidate>,
  rootFiles: ReadonlySet<string>,
): void {
  if (rootFiles.has('mvnw') || rootFiles.has('mvnw.cmd')) {
    const hasPosixWrapper = rootFiles.has('mvnw');
    addCandidate(byKind, {
      kind: 'build',
      command: hasPosixWrapper ? './mvnw verify' : 'mvnw.cmd verify',
      source: hasPosixWrapper ? 'repo:mvnw' : 'repo:mvnw.cmd',
      confidence: 'high',
      reason: 'Maven wrapper detected; wrapper command is preferred over global Maven binary',
    });
  }

  if (rootFiles.has('gradlew') || rootFiles.has('gradlew.bat')) {
    const hasPosixWrapper = rootFiles.has('gradlew');
    addCandidate(byKind, {
      kind: 'test',
      command: hasPosixWrapper ? './gradlew check' : 'gradlew.bat check',
      source: hasPosixWrapper ? 'repo:gradlew' : 'repo:gradlew.bat',
      confidence: 'high',
      reason: 'Gradle wrapper detected; wrapper command is preferred over global Gradle binary',
    });
  }
}

function addFallbackCandidates(
  byKind: Map<VerificationCandidateKind, VerificationCandidate>,
  detectedStack: DetectedStack | null | undefined,
  packageManager: PackageManager,
): void {
  if (!detectedStack) return;

  const ids = new Set(detectedStack.items.map((item) => `${item.kind}:${item.id}`));

  if (ids.has('buildTool:maven')) {
    addCandidate(byKind, {
      kind: 'build',
      command: 'mvn verify',
      source: 'detectedStack:buildTool:maven',
      confidence: 'medium',
      reason: 'Maven build tool detected without wrapper evidence',
    });
  }

  if (ids.has('buildTool:gradle') || ids.has('buildTool:gradle-kotlin')) {
    addCandidate(byKind, {
      kind: 'test',
      command: 'gradle check',
      source: ids.has('buildTool:gradle')
        ? 'detectedStack:buildTool:gradle'
        : 'detectedStack:buildTool:gradle-kotlin',
      confidence: 'medium',
      reason: 'Gradle build tool detected without wrapper evidence',
    });
  }

  if (ids.has('testFramework:vitest')) {
    addCandidate(byKind, {
      kind: 'test',
      command: fallbackCommand(packageManager, 'vitest run'),
      source: 'detectedStack:testFramework:vitest',
      confidence: 'medium',
      reason: `Vitest detected and no repo-native test script found; using ${packageManager} fallback`,
    });
  }

  if (ids.has('testFramework:jest')) {
    addCandidate(byKind, {
      kind: 'test',
      command: fallbackCommand(packageManager, 'jest'),
      source: 'detectedStack:testFramework:jest',
      confidence: 'medium',
      reason: `Jest detected and no repo-native test script found; using ${packageManager} fallback`,
    });
  }

  if (ids.has('qualityTool:eslint') || ids.has('tool:eslint')) {
    addCandidate(byKind, {
      kind: 'lint',
      command: fallbackCommand(packageManager, 'eslint .'),
      source: ids.has('qualityTool:eslint')
        ? 'detectedStack:qualityTool:eslint'
        : 'detectedStack:tool:eslint',
      confidence: 'medium',
      reason: `ESLint detected and no repo-native lint script found; using ${packageManager} fallback`,
    });
  }

  if (ids.has('language:typescript') || ids.has('tool:typescript')) {
    addCandidate(byKind, {
      kind: 'typecheck',
      command: fallbackCommand(packageManager, 'tsc --noEmit'),
      source: ids.has('language:typescript')
        ? 'detectedStack:language:typescript'
        : 'detectedStack:tool:typescript',
      confidence: 'low',
      reason: `TypeScript detected and no repo-native typecheck script found; using ${packageManager} fallback`,
    });
  }
}

function fallbackCommand(packageManager: PackageManager, command: string): string {
  if (packageManager === 'pnpm') return `pnpm ${command}`;
  if (packageManager === 'yarn') return `yarn ${command}`;
  if (packageManager === 'bun') return `bunx ${command}`;
  return `npx ${command}`;
}

function isLikelyPlaceholderTestScript(command: string): boolean {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalized.includes('no test specified') && normalized.includes('exit 1');
}
