/**
 * @module architecture/module-classification
 * @description Single classification authority for every top-level module and
 * root-level entry under `src/`.
 *
 * Default-deny: every top-level directory and every root-level `.ts` entry
 * must be classified here. `dependency-rules.test.ts` treats a relative import
 * whose target is not classified as a violation, and the completeness ratchet
 * fails when a new top-level entry appears without a classification.
 *
 * Kinds:
 * - `governed`: participates in the dependency rules; the positive cross-module
 *   direction authority is `MODULE_DEPENDENCY_POLICY` in
 *   `module-dependency-policy.ts`.
 * - `entry`: package entry points / public barrels. They compose broadly by
 *   design (no outbound restriction), but they are outbound-only: governed
 *   modules must not import them, because their re-exports would bypass the
 *   layer rules.
 * - `test-support`: fixtures and test policy helpers. Only test scaffolding
 *   (`*.test.ts`, `__tests__/**`, `*-test-helpers.ts`) may import them from
 *   production-class files.
 *
 * @version v1
 */

import { normalizeRepoPath } from './repo-path.js';

type ModuleKind = 'governed' | 'entry' | 'test-support';

export interface ModuleClassification {
  readonly name: string;
  readonly kind: ModuleKind;
  readonly description: string;
}

export const MODULE_CLASSIFICATION = [
  // Governed layers (historical scope of dependency-rules.test.ts).
  { name: 'state', kind: 'governed', description: 'Session state schema and evidence contracts' },
  { name: 'machine', kind: 'governed', description: 'State transitions, guards, commands' },
  { name: 'rails', kind: 'governed', description: 'Workflow rails and command orchestration' },
  {
    name: 'adapters',
    kind: 'governed',
    description: 'Persistence, workspace, git trust boundaries',
  },
  {
    name: 'integration',
    kind: 'governed',
    description: 'Host-facing runtime composition and tools',
  },
  { name: 'config', kind: 'governed', description: 'Config schema, reason codes, policy types' },
  { name: 'audit', kind: 'governed', description: 'Audit integrity, completeness, timestamps' },
  {
    name: 'discovery',
    kind: 'governed',
    description: 'Discovery and verification candidate planning',
  },
  { name: 'archive', kind: 'governed', description: 'Audit archive packaging and verification' },
  { name: 'logging', kind: 'governed', description: 'Structured logging and sinks' },
  { name: 'cli', kind: 'governed', description: 'Command-line entry points' },
  { name: 'identity', kind: 'governed', description: 'Actor identity and IdP boundary' },
  { name: 'telemetry', kind: 'governed', description: 'Human projection telemetry emitters' },
  { name: 'presentation', kind: 'governed', description: 'Presentation model and renderers' },
  { name: 'diagnostics', kind: 'governed', description: 'Outbound-only diagnostics projection' },
  { name: 'hooks', kind: 'governed', description: 'Host hook entry points' },
  { name: 'mcp-server', kind: 'governed', description: 'MCP server entry point' },
  {
    name: 'shared',
    kind: 'governed',
    description: 'Canonical cross-layer schemas and low-level primitives',
  },
  // Governed modules admitted by the default-deny tranche.
  {
    name: 'providers',
    kind: 'governed',
    description: 'Assertion provider extensions and registry',
  },
  {
    name: 'verification',
    kind: 'governed',
    description: 'Observed execution and assertion evidence',
  },
  { name: 'redaction', kind: 'governed', description: 'Export-time redaction utility' },
  { name: 'rendering', kind: 'governed', description: 'Mandate rendering primitives' },
  { name: 'templates', kind: 'governed', description: 'Installed command and mandate templates' },
  // Test-only trees: no production files; production imports are violations.
  {
    name: 'architecture',
    kind: 'test-support',
    description: 'Architecture test suites and inventories',
  },
  { name: 'documentation', kind: 'test-support', description: 'Documentation contract suites' },
  { name: 'fixtures', kind: 'test-support', description: 'Test fixture workspace' },
  { name: 'security', kind: 'test-support', description: 'Security policy test suites' },
  // Root-level entries.
  { name: 'index.ts', kind: 'entry', description: 'Package barrel' },
  { name: 'testing.ts', kind: 'entry', description: 'Public testing entry' },
  { name: 'tsa.ts', kind: 'entry', description: 'Timestamp authority public entry' },
  // Root-level test-support files.
  { name: 'fixtures.ts', kind: 'test-support', description: 'State fixture factory' },
  { name: 'test-policy.ts', kind: 'test-support', description: 'Test performance budgets' },
] as const satisfies readonly ModuleClassification[];

/** Every governed top-level module name, derived from the classification. */
export type GovernedModuleName = Extract<
  (typeof MODULE_CLASSIFICATION)[number],
  { readonly kind: 'governed' }
>['name'];

/** Name → classification lookup for path and importer-kind decisions. */
export const MODULE_CLASSIFICATION_BY_NAME: ReadonlyMap<string, ModuleClassification> = new Map(
  MODULE_CLASSIFICATION.map((entry) => [entry.name, entry]),
);

/** Conventional test/fixture directory names — explicit markers, not `__` substrings. */
const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['__tests__', '__fixtures__']);

/**
 * Conventional internal test-support file names. These are the classes that
 * must never enter the production compiler graph, the `dist/` emit, or the
 * npm tarball. `testing.ts` is deliberately NOT here: it is the public
 * `@flowguard/core/testing` entry point and stays production.
 */
const TEST_FILE_SUFFIXES = ['-test-helpers.ts', '-test-fixtures.ts'] as const;
const TEST_FILE_NAMES: ReadonlySet<string> = new Set([
  'test-helpers.ts',
  'evidence-test-constants.ts',
]);

/**
 * Semantic test classification for source inventories. A path is test code
 * when it lives under a conventional test/fixture directory, is a `.test.ts`
 * / `.spec.ts` file, is a conventional internal test-support file, or sits in
 * a classified test-support tree. Directory names containing `__` for any
 * other reason are NOT test code: name-based escape hatches would hide
 * production files from the governance inventory.
 *
 * Input is normalized through the path authority first, so a caller that
 * passes a native filesystem path with `\` separators still receives the
 * canonical classification instead of a silent non-match.
 */
export function isTestSourcePath(relativeFromSrc: string): boolean {
  const normalized = normalizeRepoPath(relativeFromSrc);
  const segments = normalized.split('/');
  if (segments.some((segment) => TEST_DIRECTORY_NAMES.has(segment))) return true;
  const fileName = segments[segments.length - 1] ?? '';
  if (fileName.endsWith('.test.ts') || fileName.endsWith('.spec.ts')) return true;
  if (TEST_FILE_NAMES.has(fileName)) return true;
  if (TEST_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) return true;
  const top = segments[0];
  return top !== undefined && MODULE_CLASSIFICATION_BY_NAME.get(top)?.kind === 'test-support';
}
