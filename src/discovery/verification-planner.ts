/**
 * @module discovery/verification-planner
 * @description Advisory verification command planner.
 *
 * Derives evidence-backed, repo-native verification command candidates from:
 * - detected stack items (tool/framework/package-manager evidence)
 * - root package.json scripts
 * - root Java wrapper files (mvnw/gradlew)
 * - execution profiles from the assertion provider catalog
 *
 * Planner only: it never executes commands.
 *
 * @version v3
 */

import type { DetectedStack, VerificationCandidate, VerificationCandidateKind } from './types.js';
import type { ExecutionSubjectInput } from '../state/discovery-schemas.js';
import {
  ASSERTION_PROFILES,
  REPORT_TEMPLATES_BY_PROVIDER,
  SCRIPT_SIGNATURES_BY_PROVIDER,
  type PlannerContext,
  type ScriptSignature,
} from '../providers/registry.js';
import { buildScriptInvocation, type PackageManager } from './package-script-command.js';
import { analyzeVerificationScript } from './verification-script-analysis.js';
import type { ProviderId } from '../state/assertion-identity.js';
import type { PlannedVerificationCandidate } from './verification-candidate-planned.js';

type ReadFileFn = (relativePath: string) => Promise<string | undefined>;

interface VerificationPlannerInput {
  readonly detectedStack: DetectedStack | null | undefined;
  readonly allFiles: readonly string[];
  readonly readFile: ReadFileFn;
}

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
 * 1) package.json scripts (highest priority — never overwritten by fallbacks)
 * 2) wrapper commands via execution profiles (mvnw/gradlew)
 * 3) tool defaults from detected stack (non-assertion: eslint, tsc)
 * 4) assertion execution profile fallbacks
 */
export async function planVerificationCandidates(
  input: VerificationPlannerInput,
): Promise<PlannedVerificationCandidate[]> {
  const byKind = new Map<VerificationCandidateKind, PlannedVerificationCandidate>();
  const rootFiles = new Set(input.allFiles.filter((f) => !f.includes('/') && !f.includes('\\')));
  const packageManager = detectPackageManager(input.detectedStack, rootFiles);
  const detectedStackIds = new Set(
    (input.detectedStack?.items ?? []).map((item) => `${item.kind}:${item.id}`),
  );

  const ctx: PlannerContext = {
    rootFiles,
    packageManager,
    detectedStackIds,
  };

  const scripts = await readPackageScripts(input.readFile);
  addScriptCandidates(byKind, scripts, packageManager);

  applyProfiles(byKind, ctx, ASSERTION_PROFILES);

  addNonAssertionFallbacks(byKind, detectedStackIds, packageManager);

  return [...byKind.values()].sort((a, b) => {
    const orderDiff = KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind];
    if (orderDiff !== 0) return orderDiff;
    return a.candidate.command.localeCompare(b.candidate.command);
  });
}

/**
 * Strip executionProfileId from planned candidates to produce the
 * provider-neutral VerificationCandidate[] for state persistence.
 */
export function stripToCandidates(
  planned: readonly PlannedVerificationCandidate[],
): VerificationCandidate[] {
  return planned.map((p) => p.candidate);
}

/**
 * Extract execution subject inputs from planned candidates, keyed by kind,
 * for persistence alongside the provider-neutral VerificationCandidate list.
 */
export function extractExecutionSubjectInputs(
  planned: readonly PlannedVerificationCandidate[],
): Record<string, ExecutionSubjectInput[]> {
  const map: Record<string, ExecutionSubjectInput[]> = {};
  for (const p of planned) {
    if (p.executionSubjectInputs.length > 0) {
      map[p.candidate.kind] = [...p.executionSubjectInputs];
    }
  }
  return map;
}

function applyProfiles(
  byKind: Map<VerificationCandidateKind, PlannedVerificationCandidate>,
  ctx: PlannerContext,
  profiles: ReadonlyArray<{
    readonly profileId?: string;
    readonly kind: VerificationCandidateKind;
    createCandidate(ctx: PlannerContext): VerificationCandidate | null;
  }>,
): void {
  for (const profile of profiles) {
    if (byKind.has(profile.kind)) continue;

    const raw = profile.createCandidate(ctx);
    if (raw) {
      byKind.set(raw.kind, {
        candidate: raw,
        executionProfileId: profile.profileId,
        executionSubjectInputs: [{ kind: 'implementation' as const }],
      });
    }
  }
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

function addScriptCandidates(
  byKind: Map<VerificationCandidateKind, PlannedVerificationCandidate>,
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

  const signatureMap = buildSignatureMap();

  for (const mapping of mappings) {
    if (!(mapping.script in scripts)) continue;
    const command = scripts[mapping.script]!;
    if (isLikelyPlaceholderScript(command)) continue;
    if (byKind.has(mapping.kind)) continue;

    const analysis = analyzeVerificationScript(mapping.script, command, signatureMap);

    const canEnrich =
      analysis.provider.status === 'identified' &&
      !analysis.isCompound &&
      !analysis.reporterConfigurationPresent &&
      analysis.argumentForwarding === 'supported';

    if (canEnrich) {
      const reportTemplate = REPORT_TEMPLATES_BY_PROVIDER.get(analysis.provider.providerId);

      if (reportTemplate) {
        byKind.set(mapping.kind, {
          candidate: {
            assertionCapability: 'structured' as const,
            kind: mapping.kind,
            command: buildScriptInvocation(packageManager, mapping.script).command,
            source: `package.json:scripts.${mapping.script}`,
            confidence: 'high',
            reason: `Repo-native ${mapping.script} script enriched: ${analysis.provider.evidence} (provider: ${analysis.provider.providerId})`,
            assertionReport: reportTemplate,
          },
          executionSubjectInputs: [
            { kind: 'implementation' as const },
            { kind: 'file' as const, path: 'package.json' },
          ],
        });
        continue;
      }
    }

    let reason = `Repo-native ${mapping.script} script detected and ${packageManager} package manager detected`;
    if (analysis.provider.status === 'identified') {
      if (analysis.isCompound) {
        reason += `; provider '${analysis.provider.providerId}' detected but script is a compound shell command`;
      } else if (analysis.reporterConfigurationPresent) {
        reason += `; existing reporter configuration detected, cannot safely enrich`;
      }
    }

    byKind.set(mapping.kind, {
      candidate: {
        assertionCapability: 'unsupported' as const,
        kind: mapping.kind,
        command: buildScriptInvocation(packageManager, mapping.script).command,
        source: `package.json:scripts.${mapping.script}`,
        confidence: 'high',
        reason,
      },
      executionSubjectInputs: [
        { kind: 'implementation' as const },
        { kind: 'file' as const, path: 'package.json' },
      ],
    });
  }
}

function buildSignatureMap(): ReadonlyMap<ProviderId, readonly ScriptSignature[]> {
  const map = new Map<ProviderId, ScriptSignature[]>();
  for (const [providerId, sigs] of SCRIPT_SIGNATURES_BY_PROVIDER) {
    if (sigs.length > 0) {
      map.set(providerId, [...sigs]);
    }
  }
  return map;
}

function addNonAssertionFallbacks(
  byKind: Map<VerificationCandidateKind, PlannedVerificationCandidate>,
  ids: ReadonlySet<string>,
  packageManager: PackageManager,
): void {
  if (ids.has('buildTool:maven') && !byKind.has('build')) {
    byKind.set('build', {
      candidate: {
        assertionCapability: 'unsupported' as const,
        kind: 'build',
        command: 'mvn verify',
        source: 'detectedStack:buildTool:maven',
        confidence: 'medium',
        reason: 'Maven build tool detected without wrapper evidence',
      },
      executionSubjectInputs: [{ kind: 'implementation' as const }],
    });
  }

  if ((ids.has('buildTool:gradle') || ids.has('buildTool:gradle-kotlin')) && !byKind.has('test')) {
    byKind.set('test', {
      candidate: {
        assertionCapability: 'unsupported' as const,
        kind: 'test',
        command: 'gradle check',
        source: ids.has('buildTool:gradle')
          ? 'detectedStack:buildTool:gradle'
          : 'detectedStack:buildTool:gradle-kotlin',
        confidence: 'medium',
        reason: 'Gradle build tool detected without wrapper evidence',
      },
      executionSubjectInputs: [{ kind: 'implementation' as const }],
    });
  }

  if ((ids.has('qualityTool:eslint') || ids.has('tool:eslint')) && !byKind.has('lint')) {
    byKind.set('lint', {
      candidate: {
        assertionCapability: 'unsupported' as const,
        kind: 'lint',
        command: fallbackCommand(packageManager, 'eslint .'),
        source: ids.has('qualityTool:eslint')
          ? 'detectedStack:qualityTool:eslint'
          : 'detectedStack:tool:eslint',
        confidence: 'medium',
        reason: `ESLint detected and no repo-native lint script found; using ${packageManager} fallback`,
      },
      executionSubjectInputs: [{ kind: 'implementation' as const }],
    });
  }

  if ((ids.has('language:typescript') || ids.has('tool:typescript')) && !byKind.has('typecheck')) {
    byKind.set('typecheck', {
      candidate: {
        assertionCapability: 'unsupported' as const,
        kind: 'typecheck',
        command: fallbackCommand(packageManager, 'tsc --noEmit'),
        source: ids.has('language:typescript')
          ? 'detectedStack:language:typescript'
          : 'detectedStack:tool:typescript',
        confidence: 'low',
        reason: `TypeScript detected and no repo-native typecheck script found; using ${packageManager} fallback`,
      },
      executionSubjectInputs: [{ kind: 'implementation' as const }],
    });
  }
}

function fallbackCommand(packageManager: PackageManager, command: string): string {
  if (packageManager === 'pnpm') return `pnpm ${command}`;
  if (packageManager === 'yarn') return `yarn ${command}`;
  if (packageManager === 'bun') return `bunx ${command}`;
  return `npx ${command}`;
}

function isLikelyPlaceholderScript(command: string): boolean {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();

  if (normalized === 'exit 1' || normalized === 'todo' || normalized === 'not implemented') {
    return true;
  }

  const noTestSpecifiedEcho =
    /^echo\s+['"`]?(?:error:\s*)?no test specified['"`]?(?:\s*&&\s*exit\s+1)?\s*;?$/;
  const todoEcho = /^echo\s+['"`]?todo['"`]?(?:\s*&&\s*exit\s+1)?\s*;?$/;
  const notImplementedEcho = /^echo\s+['"`]?not implemented['"`]?(?:\s*&&\s*exit\s+1)?\s*;?$/;

  return (
    noTestSpecifiedEcho.test(normalized) ||
    todoEcho.test(normalized) ||
    notImplementedEcho.test(normalized)
  );
}
