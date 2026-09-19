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

import type {
  DetectedStack,
  ExecutionSubjectInput,
  UnidentifiedVerificationCandidate,
  VerificationCandidate,
  VerificationCandidateKind,
} from '../state/discovery-schemas.js';
import {
  ASSERTION_PROFILES,
  PROFILE_BY_ID,
  SCRIPT_SIGNATURES_BY_PROVIDER,
  type PlannerContext,
  type ExecutionProfile,
  type ExecutionSubjectResolution,
  type ScriptSignature,
} from '../providers/registry.js';
import { buildScriptInvocation, type PackageManager } from './package-script-command.js';
import { analyzeVerificationScript, type ScriptAnalysis } from './verification-script-analysis.js';
import type { ProviderId } from '../state/assertion-identity.js';
import type {
  IdentifiedPlannedVerificationCandidate,
  PlannedVerificationCandidate,
} from './verification-candidate-planned.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { hashText } from '../shared/hashing.js';

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
 * Order planned candidates by verification kind, then by command. Extracted so
 * the comparator is directly testable (array sorts of small candidate sets are
 * insertion-based in V8 and mask comparator regressions).
 */
export function comparePlannedCandidates(
  a: PlannedVerificationCandidate,
  b: PlannedVerificationCandidate,
): number {
  const orderDiff = KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind];
  if (orderDiff !== 0) return orderDiff;
  return a.candidate.command.localeCompare(b.candidate.command);
}

/**
 * Plan advisory verification candidates using repo-first precedence:
 * 1) package.json scripts (highest priority — never overwritten by fallbacks)
 * 2) wrapper commands via execution profiles (mvnw/gradlew)
 * 3) tool defaults from detected stack (non-assertion: eslint, tsc)
 * 4) assertion execution profile fallbacks
 */
export async function planVerificationCandidates(
  input: VerificationPlannerInput,
): Promise<IdentifiedPlannedVerificationCandidate[]> {
  const byKind = new Map<string, PlannedVerificationCandidate>();
  const blockedKinds = new Set<VerificationCandidateKind>();
  const rootFiles = new Set(input.allFiles.filter((f) => !f.includes('/') && !f.includes('\\')));
  const packageManager = detectPackageManager(input.detectedStack, rootFiles);
  const detectedStackIds = new Set(
    (input.detectedStack?.items ?? []).map((item) => `${item.kind}:${item.id}`),
  );

  const ctx: PlannerContext = {
    allFiles: input.allFiles,
    readFile: input.readFile,
    rootFiles,
    packageManager,
    detectedStackIds,
  };

  const scripts = await readPackageScripts(input.readFile);
  await addScriptCandidates(byKind, blockedKinds, scripts, packageManager, ctx);

  await applyProfiles(byKind, blockedKinds, ctx, ASSERTION_PROFILES);

  addNonAssertionFallbacks(byKind, blockedKinds, ctx, detectedStackIds, packageManager);

  const ordered = [...byKind.values()].sort(comparePlannedCandidates);
  return ordered.map(identifyPlannedCandidate);
}

/**
 * Mint the deterministic planner identity for one candidate. The identity is
 * the hash of the identity-free candidate, so every plan produces stable ids
 * across runs.
 */
function identifyPlannedCandidate(
  planned: PlannedVerificationCandidate,
): IdentifiedPlannedVerificationCandidate {
  const candidateId = `vc_${hashText(canonicalJsonStringify(planned.candidate))}`;
  const candidate = planned.candidate;
  return {
    ...planned,
    candidate:
      candidate.assertionCapability === 'structured'
        ? { ...candidate, candidateId }
        : { ...candidate, candidateId },
  };
}

/**
 * Strip executionProfileId from planned candidates to produce the
 * provider-neutral VerificationCandidate[] for state persistence.
 */
export function stripToCandidates(
  planned: readonly IdentifiedPlannedVerificationCandidate[],
): VerificationCandidate[] {
  return planned.map((p) => p.candidate);
}

/** Extract candidate-specific execution subject inputs for exact candidate execution. */
export function extractExecutionSubjectInputsByCandidateId(
  planned: readonly IdentifiedPlannedVerificationCandidate[],
): Record<string, ExecutionSubjectInput[]> {
  const map: Record<string, ExecutionSubjectInput[]> = {};
  for (const p of planned) {
    if (p.executionSubjectInputs.length > 0) {
      map[p.candidate.candidateId] = [...p.executionSubjectInputs];
    }
  }
  return map;
}

/** Alternate evidence routes preserve the repo-native execution authority. */
function routeProfileCandidate(
  profile: ExecutionProfile,
  raw: UnidentifiedVerificationCandidate,
  defaultPlan: PlannedVerificationCandidate | undefined,
): UnidentifiedVerificationCandidate {
  if (!profile.alternate || !defaultPlan) return raw;
  return { ...raw, command: defaultPlan.candidate.command, source: defaultPlan.candidate.source };
}

function resolveProfileScopeSemanticCommand(
  profile: ExecutionProfile,
  raw: UnidentifiedVerificationCandidate,
  defaultPlan: PlannedVerificationCandidate | undefined,
): string {
  if (profile.alternate && defaultPlan?.scopeSemanticCommand) {
    return defaultPlan.scopeSemanticCommand;
  }
  return raw.command;
}

async function resolveProfileSubjectInputs(
  profile: ExecutionProfile,
  ctx: PlannerContext,
): Promise<ExecutionSubjectResolution> {
  const result = profile.resolveExecutionSubjectInputs
    ? await profile.resolveExecutionSubjectInputs(ctx)
    : [];
  return normalizeSubjectResolution(result);
}

async function applyProfiles(
  byKind: Map<string, PlannedVerificationCandidate>,
  blockedKinds: Set<VerificationCandidateKind>,
  ctx: PlannerContext,
  profiles: ReadonlyArray<ExecutionProfile>,
): Promise<void> {
  for (const profile of profiles) {
    if (blockedKinds.has(profile.kind)) continue;
    if (byKind.has(profile.kind) && !profile.alternate) continue;

    const raw = profile.createCandidate(ctx);
    if (!raw) continue;

    const defaultPlan = byKind.get(profile.kind);
    const routed = routeProfileCandidate(profile, raw, defaultPlan);
    const scopeSemanticCommand = resolveProfileScopeSemanticCommand(profile, raw, defaultPlan);
    const resolution = await resolveProfileSubjectInputs(profile, ctx);
    if (resolution.kind === 'blocked') {
      blockedKinds.add(profile.kind);
      continue;
    }

    const subjectInputs: ExecutionSubjectInput[] = [{ kind: 'implementation' as const }];
    for (const f of resolution.inputs) subjectInputs.push(f);
    byKind.set(profile.alternate ? profile.profileId : raw.kind, {
      candidate: attestFullCheckScope(profile, routed, scopeSemanticCommand),
      executionProfileId: profile.profileId,
      scopeSemanticCommand,
      executionSubjectInputs: subjectInputs,
    });
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

/** One package.json script mapped to the verification kind it satisfies. */
interface ScriptKindMapping {
  readonly kind: VerificationCandidateKind;
  readonly script: string;
}

const SCRIPT_CANDIDATE_MAPPINGS: readonly ScriptKindMapping[] = [
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

type ScriptEnrichment =
  | { readonly kind: 'enriched'; readonly plan: PlannedVerificationCandidate }
  | { readonly kind: 'blocked' }
  /** The script kind contradicts the identified provider kind: emit no candidate. */
  | { readonly kind: 'skip' }
  | { readonly kind: 'fallback' };

function isEnrichableScript(analysis: ScriptAnalysis): analysis is ScriptAnalysis & {
  provider: Extract<ScriptAnalysis['provider'], { status: 'identified' }>;
} {
  return (
    analysis.provider.status === 'identified' &&
    !analysis.isCompound &&
    !analysis.reporterConfigurationPresent &&
    analysis.argumentForwarding === 'supported'
  );
}

async function enrichScriptCandidate(
  mapping: ScriptKindMapping,
  command: string,
  analysis: ScriptAnalysis,
  packageManager: PackageManager,
  ctx: PlannerContext,
): Promise<ScriptEnrichment> {
  if (!isEnrichableScript(analysis)) return { kind: 'fallback' };
  if (analysis.provider.candidateKind !== mapping.kind) return { kind: 'skip' };
  const profileId = analysis.provider.executionProfileId;
  const profile = PROFILE_BY_ID.get(profileId);
  if (!profile) return { kind: 'fallback' };

  const resolution = normalizeSubjectResolution(
    profile.resolveExecutionSubjectInputs
      ? await profile.resolveExecutionSubjectInputs(ctx, {
          ...(analysis.provider.matchedExecutable !== undefined
            ? { matchedExecutable: analysis.provider.matchedExecutable }
            : {}),
        })
      : [],
  );
  if (resolution.kind === 'blocked') return { kind: 'blocked' };

  return {
    kind: 'enriched',
    plan: {
      candidate: attestFullCheckScope(
        profile,
        {
          assertionCapability: 'structured' as const,
          kind: mapping.kind,
          command: buildScriptInvocation(packageManager, mapping.script).command,
          source: `package.json:scripts.${mapping.script}`,
          confidence: 'high',
          reason: `Repo-native ${mapping.script} script enriched via ${profileId}`,
          assertionReport: profile.assertionReport,
        },
        command,
      ),
      executionProfileId: profileId,
      scopeSemanticCommand: command,
      executionSubjectInputs: [
        { kind: 'implementation' as const },
        { kind: 'file' as const, path: 'package.json' },
        ...resolution.inputs,
      ],
    },
  };
}

function buildPlainScriptCandidateReason(
  mapping: ScriptKindMapping,
  analysis: ScriptAnalysis,
  packageManager: PackageManager,
): string {
  let reason = `Repo-native ${mapping.script} script detected and ${packageManager} package manager detected`;
  if (analysis.provider.status === 'identified') {
    if (analysis.isCompound) {
      reason += `; provider '${analysis.provider.providerId}' detected but script is a compound shell command`;
    } else if (analysis.reporterConfigurationPresent) {
      reason += `; existing reporter configuration detected, cannot safely enrich`;
    }
  }
  return reason;
}

function buildPlainScriptCandidate(
  mapping: ScriptKindMapping,
  command: string,
  analysis: ScriptAnalysis,
  packageManager: PackageManager,
): PlannedVerificationCandidate {
  return {
    candidate: {
      assertionCapability: 'unsupported' as const,
      kind: mapping.kind,
      command: buildScriptInvocation(packageManager, mapping.script).command,
      source: `package.json:scripts.${mapping.script}`,
      confidence: 'high',
      reason: buildPlainScriptCandidateReason(mapping, analysis, packageManager),
    },
    executionSubjectInputs: [
      { kind: 'implementation' as const },
      { kind: 'file' as const, path: 'package.json' },
    ],
  };
}

async function addScriptCandidates(
  byKind: Map<string, PlannedVerificationCandidate>,
  blockedKinds: Set<VerificationCandidateKind>,
  scripts: Record<string, string>,
  packageManager: PackageManager,
  _ctx: PlannerContext,
): Promise<void> {
  const signatureMap = buildSignatureMap();

  for (const mapping of SCRIPT_CANDIDATE_MAPPINGS) {
    const command = scripts[mapping.script];
    if (command === undefined) continue;
    if (isLikelyPlaceholderScript(command)) continue;
    if (byKind.has(mapping.kind)) continue;

    const analysis = analyzeVerificationScript(mapping.script, command, signatureMap);
    const enrichment = await enrichScriptCandidate(
      mapping,
      command,
      analysis,
      packageManager,
      _ctx,
    );
    if (enrichment.kind === 'blocked') {
      blockedKinds.add(mapping.kind);
      continue;
    }
    if (enrichment.kind === 'skip') continue;
    if (enrichment.kind === 'enriched') {
      byKind.set(mapping.kind, enrichment.plan);
      continue;
    }
    byKind.set(mapping.kind, buildPlainScriptCandidate(mapping, command, analysis, packageManager));
  }
}

function normalizeSubjectResolution(
  result: readonly ExecutionSubjectInput[] | ExecutionSubjectResolution,
): ExecutionSubjectResolution {
  return 'kind' in result ? result : { kind: 'resolved', inputs: result };
}

function attestFullCheckScope(
  profile: { attestFullCheckScope?(command: string): boolean },
  candidate: UnidentifiedVerificationCandidate,
  scopeSemanticCommand: string,
): UnidentifiedVerificationCandidate {
  if (
    candidate.assertionCapability === 'structured' &&
    profile.attestFullCheckScope?.(scopeSemanticCommand) === true
  ) {
    return { ...candidate, fullCheckScopeAttestation: 'full_check' };
  }
  return candidate;
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

function setNonAssertionFallback(
  byKind: Map<string, PlannedVerificationCandidate>,
  candidate: UnidentifiedVerificationCandidate,
): void {
  byKind.set(candidate.kind, {
    candidate,
    executionSubjectInputs: [{ kind: 'implementation' as const }],
  });
}

function addMavenBuildFallback(
  byKind: Map<string, PlannedVerificationCandidate>,
  blockedKinds: ReadonlySet<VerificationCandidateKind>,
  ctx: PlannerContext,
  ids: ReadonlySet<string>,
): void {
  if (
    ids.has('buildTool:maven') &&
    !ctx.allFiles?.includes('.mvn/maven.config') &&
    !blockedKinds.has('build') &&
    !byKind.has('build')
  ) {
    setNonAssertionFallback(byKind, {
      assertionCapability: 'unsupported' as const,
      kind: 'build',
      command: 'mvn verify',
      source: 'detectedStack:buildTool:maven',
      confidence: 'medium',
      reason: 'Maven build tool detected without wrapper evidence',
    });
  }
}

function addGradleTestFallback(
  byKind: Map<string, PlannedVerificationCandidate>,
  blockedKinds: ReadonlySet<VerificationCandidateKind>,
  ids: ReadonlySet<string>,
): void {
  if (
    (ids.has('buildTool:gradle') || ids.has('buildTool:gradle-kotlin')) &&
    !blockedKinds.has('test') &&
    !byKind.has('test')
  ) {
    setNonAssertionFallback(byKind, {
      assertionCapability: 'unsupported' as const,
      kind: 'test',
      command: 'gradle check',
      source: ids.has('buildTool:gradle')
        ? 'detectedStack:buildTool:gradle'
        : 'detectedStack:buildTool:gradle-kotlin',
      confidence: 'medium',
      reason: 'Gradle build tool detected without wrapper evidence',
    });
  }
}

function addEslintLintFallback(
  byKind: Map<string, PlannedVerificationCandidate>,
  ids: ReadonlySet<string>,
  packageManager: PackageManager,
): void {
  if ((ids.has('qualityTool:eslint') || ids.has('tool:eslint')) && !byKind.has('lint')) {
    setNonAssertionFallback(byKind, {
      assertionCapability: 'unsupported' as const,
      kind: 'lint',
      command: fallbackCommand(packageManager, 'eslint .'),
      source: ids.has('qualityTool:eslint')
        ? 'detectedStack:qualityTool:eslint'
        : 'detectedStack:tool:eslint',
      confidence: 'medium',
      reason: `ESLint detected and no repo-native lint script found; using ${packageManager} fallback`,
    });
  }
}

function addTypeScriptTypecheckFallback(
  byKind: Map<string, PlannedVerificationCandidate>,
  ids: ReadonlySet<string>,
  packageManager: PackageManager,
): void {
  if ((ids.has('language:typescript') || ids.has('tool:typescript')) && !byKind.has('typecheck')) {
    setNonAssertionFallback(byKind, {
      assertionCapability: 'unsupported' as const,
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

function addNonAssertionFallbacks(
  byKind: Map<string, PlannedVerificationCandidate>,
  blockedKinds: ReadonlySet<VerificationCandidateKind>,
  ctx: PlannerContext,
  ids: ReadonlySet<string>,
  packageManager: PackageManager,
): void {
  addMavenBuildFallback(byKind, blockedKinds, ctx, ids);
  addGradleTestFallback(byKind, blockedKinds, ids);
  addEslintLintFallback(byKind, ids, packageManager);
  addTypeScriptTypecheckFallback(byKind, ids, packageManager);
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
