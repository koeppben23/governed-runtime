/**
 * @module integration/risk-path-classifier
 * @description Canonical path classification for task classes and ceremony
 * eligibility: instruction/config/high-risk surfaces and the conservative
 * minimum task class over a file set.
 *
 * @version v1
 */

import { maxTaskClass, type TaskClass } from '../state/task-class.js';
import type { RiskTrigger } from '../state/schema.js';

const HIGH_RISK_PREFIXES = [
  'src/state/',
  'src/machine/',
  'src/audit/',
  'src/archive/',
  'src/config/',
  'src/evidence/',
  'src/identity/',
  'src/security/',
  'src/adapters/persistence',
  'src/adapters/persistence-lock',
  'src/adapters/persistence-audit',
  'src/adapters/persistence-config',
  'src/adapters/persistence-discovery',
  'src/cli/uninstall',
  'src/integration/review/',
  'src/integration/plugin',
  'src/integration/phase-tool-gate',
  'src/rails/review',
  'src/templates/commands/',
  'scripts/release',
  'scripts/install',
  'scripts/uninstall',
  '.github/',
  '.opencode/',
] as const;

const HIGH_RISK_EXACT = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'docs/admin-model.md',
  'docs/commands.md',
  'docs/configuration.md',
  'docs/data-classification.md',
  'docs/phases.md',
  'docs/policies.md',
  'docs/profiles.md',
  'docs/retention-recovery.md',
  'docs/release-policy.md',
  'docs/security-hardening.md',
  'docs/trust-boundaries.md',
  'docs/upgrade-rollback.md',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'src/templates/mandates.ts',
  'src/rendering/mandates-renderer.ts',
  'src/templates/mandates-reviewer-criteria.ts',
]);

const HIGH_RISK_RE = [
  /^docs\/agent-guidance\/.*(mandate|guidance|high-risk|review)/,
  /^docs\/.*(mandates?|governance|mapping)\.md$/,
  /^src\/cli\/(install|uninstall|doctor|release)/,
  /^src\/config\/policy/,
  /^src\/integration\/(phase-tool-gate|plugin|review|.*policy)/,
  /^src\/migration(s)?\//,
  /^src\/rails\/(review|review-decision)/,
  /^src\/templates\/commands\//,
  /(^|\/)release(\/|[-_].*)/,
  /(^|\/)installer?(\/|[-_].*)/,
  /(^|\/)migration(s)?(\/|[-_].*)/,
  // Instruction-surface parity: nested agent instructions and their directories
  // steer agents/permissions and must never classify as TRIVIAL.
  /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/,
  /(^|\/)copilot-instructions\.md$/,
  /(^|\/)\.(claude|gemini|opencode)(\/|$)/,
] as const;

const GOVERNANCE_DOC_RE =
  /(^|\/)(architecture|security|compliance|release|governance|policy)(\/|[-_].*\.md$|\.md$)/;

export function normalizePathForRisk(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Repo-root tool/editor configuration files that are NOT a governed domain
 * surface and must not, on their own, raise the risk floor or count as
 * implementation domain files.
 *
 * Deliberately narrow and explicit (not a blanket `*.json`): only well-known
 * tooling config at the repository ROOT. High-risk config — `package.json`,
 * lockfiles, anything under `.opencode/` — is NOT listed here and is classified
 * by the HIGH_RISK_* sets BEFORE this predicate is consulted, so it stays
 * HIGH-RISK. A project-level config that carries real behavior (e.g. an app
 * `config.json` nested in source) is also excluded because this matches only
 * exact root basenames.
 */
const NON_DOMAIN_CONFIG_BASENAMES = new Set([
  'opencode.json',
  'opencode.jsonc',
  'tsconfig.json',
  'tsconfig.base.json',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
  'eslint.config.js',
  'eslint.config.mjs',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.editorconfig',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
]);

/**
 * True for a repo-root tool/editor config file that is not a governed domain
 * surface. Matches only ROOT-level paths (no `/` after normalization) against
 * an explicit allowlist. Never matches high-risk config (package.json,
 * lockfiles, `.opencode/`), which the HIGH_RISK_* sets own.
 */
export function isNonDomainConfigPath(filePath: string): boolean {
  const p = normalizePathForRisk(filePath);
  if (p.includes('/')) return false; // root-level only
  return NON_DOMAIN_CONFIG_BASENAMES.has(p);
}

/** Agent/user instruction basenames that never qualify for reduced ceremony. */
const INSTRUCTION_BASENAMES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'copilot-instructions.md',
]);

/** Instruction or control-plane directories that never qualify, at any depth. */
const INSTRUCTION_DIR_NAMES = new Set(['.claude', '.gemini', '.opencode']);

/**
 * Ceremony-specific eligibility boundary. Separate from the general task-class
 * taxonomy: a file may be TRIVIAL in the general model and still be excluded
 * from ceremony reduction because it steers agents, permissions or the
 * control plane. Normalized match on every path.
 */
export function reducedCeremonyEligible(changedFiles: readonly string[]): boolean {
  if (changedFiles.length === 0) return false;
  return changedFiles.every((filePath) => {
    const normalized = normalizePathForRisk(filePath);
    const segments = normalized.split('/');
    const basename = segments[segments.length - 1] ?? '';
    if (INSTRUCTION_BASENAMES.has(basename)) return false;
    if (segments.some((segment) => INSTRUCTION_DIR_NAMES.has(segment))) return false;
    if (isNonDomainConfigPath(normalized)) return false;
    return true;
  });
}

const RISK_TRIGGER_RULES: ReadonlyArray<{
  readonly trigger: Exclude<RiskTrigger, 'ceremony_only'>;
  readonly pattern: RegExp;
}> = [
  { trigger: 'state_integrity', pattern: /^src\/(state|machine)\// },
  { trigger: 'audit_authority', pattern: /^src\/(audit\/|adapters\/persistence-audit)/ },
  { trigger: 'identity_boundary', pattern: /^src\/(identity|security)\// },
  { trigger: 'approval_authority', pattern: /^src\/(integration\/review\/|rails\/review)/ },
  {
    trigger: 'policy_authority',
    pattern: /^src\/config\/(.*(policy|schema|resolver|preset|default).*|flowguard-config\.ts)$/,
  },
  { trigger: 'migration', pattern: /(^|\/)migration(s)?(\/|[-_].*)/ },
  {
    trigger: 'distribution_integrity',
    pattern:
      /^(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|scripts\/(release|install|uninstall)|src\/cli\/(install|uninstall|release))|(^|\/)(release|installer?)(\/|[-_].*)/,
  },
  {
    trigger: 'command_contract',
    pattern:
      /^src\/(templates\/commands\/|templates\/mandates\.ts|rendering\/mandates-renderer\.ts|templates\/mandates-reviewer-criteria\.ts)/,
  },
];

function riskTriggersForPath(p: string): readonly Exclude<RiskTrigger, 'ceremony_only'>[] {
  return RISK_TRIGGER_RULES.filter((rule) => rule.pattern.test(p))
    .map((rule) => rule.trigger)
    .sort();
}

function classifyPath(filePath: string): {
  minimumTaskClass: TaskClass;
  surface: string;
  riskTriggers: readonly Exclude<RiskTrigger, 'ceremony_only'>[];
} {
  const p = normalizePathForRisk(filePath);
  if (
    HIGH_RISK_EXACT.has(p) ||
    HIGH_RISK_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
    HIGH_RISK_RE.some((pattern) => pattern.test(p))
  ) {
    return { minimumTaskClass: 'HIGH-RISK', surface: p, riskTriggers: riskTriggersForPath(p) };
  }
  // Root-level tool/editor config (opencode.json, tsconfig.json, ...) is not a
  // governed domain surface and must not impose a STANDARD floor. High-risk
  // config (package.json, lockfiles, .opencode/) already returned above.
  if (isNonDomainConfigPath(p)) {
    return { minimumTaskClass: 'TRIVIAL', surface: p, riskTriggers: [] };
  }
  if (p === 'CHANGELOG.md' || GOVERNANCE_DOC_RE.test(p)) {
    return { minimumTaskClass: 'STANDARD', surface: p, riskTriggers: [] };
  }
  if (p.endsWith('.test.ts') || p.endsWith('.spec.ts')) {
    return { minimumTaskClass: 'STANDARD', surface: p, riskTriggers: [] };
  }
  if (p.endsWith('.md')) {
    return { minimumTaskClass: 'TRIVIAL', surface: p, riskTriggers: [] };
  }
  return { minimumTaskClass: 'STANDARD', surface: p, riskTriggers: [] };
}

export function assessMinimumTaskClass(paths: readonly string[]): {
  readonly minimumTaskClass: TaskClass;
  readonly touchedSurfaces: readonly string[];
  readonly riskTriggers: readonly RiskTrigger[];
} {
  if (paths.length === 0) {
    return { minimumTaskClass: 'TRIVIAL', touchedSurfaces: [], riskTriggers: [] };
  }
  let minimumTaskClass: TaskClass = 'TRIVIAL';
  const touchedSurfaces = new Set<string>();
  const riskTriggers = new Set<Exclude<RiskTrigger, 'ceremony_only'>>();
  for (const filePath of paths) {
    const classified = classifyPath(filePath);
    minimumTaskClass = maxTaskClass(minimumTaskClass, classified.minimumTaskClass);
    touchedSurfaces.add(classified.surface);
    classified.riskTriggers.forEach((trigger) => riskTriggers.add(trigger));
  }
  return {
    minimumTaskClass,
    touchedSurfaces: [...touchedSurfaces].sort(),
    // Ceremony-only marks a HIGH-RISK result whose matching paths have no
    // specific ProofGraph authority. It never accompanies a specific trigger.
    riskTriggers:
      minimumTaskClass === 'HIGH-RISK' && riskTriggers.size === 0
        ? ['ceremony_only']
        : [...riskTriggers].sort(),
  };
}
