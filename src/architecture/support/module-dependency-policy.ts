/**
 * @module architecture/module-dependency-policy
 * @description The single positive top-level module-direction authority.
 *
 * Every governed module (`MODULE_CLASSIFICATION`, kind `governed`) has exactly
 * one entry here: the exact set of governed modules it may import. Intra-module
 * imports are implicitly allowed. The policy is an EXACT projection of the
 * production import graph — a new observed edge without a policy change fails,
 * and a policy edge without an observed edge fails as stale policy. An
 * architectural direction change is therefore always a visible change of both
 * code and this authority in the same pull request.
 *
 * Module-level cycles are prohibited outright: the graph MUST contain zero
 * cyclic edges and zero cyclic strongly connected components. There is no
 * cycle-debt baseline; the policy records the current acyclic topology.
 *
 * @version v1
 */

import type { GovernedModuleName } from './module-classification.js';

export const MODULE_DEPENDENCY_POLICY: Readonly<
  Record<GovernedModuleName, ReadonlySet<GovernedModuleName>>
> = {
  state: new Set(['shared']),
  machine: new Set(['state']),
  rails: new Set([
    'adapters',
    'audit',
    'config',
    'discovery',
    'identity',
    'machine',
    'shared',
    'state',
  ]),
  adapters: new Set([
    'archive',
    'audit',
    'config',
    'discovery',
    'identity',
    'logging',
    'machine',
    'redaction',
    'shared',
    'state',
    'telemetry',
  ]),
  integration: new Set([
    'adapters',
    'audit',
    'config',
    'diagnostics',
    'discovery',
    'logging',
    'machine',
    'presentation',
    'providers',
    'rails',
    'rendering',
    'shared',
    'state',
    'telemetry',
    'templates',
    'verification',
  ]),
  config: new Set(['discovery', 'identity', 'logging', 'shared', 'state']),
  audit: new Set(['config', 'identity', 'logging', 'machine', 'shared', 'state']),
  discovery: new Set(['providers', 'shared', 'state', 'telemetry']),
  archive: new Set(['shared']),
  logging: new Set(['shared']),
  cli: new Set([
    'adapters',
    'audit',
    'config',
    'logging',
    'rendering',
    'shared',
    'state',
    'templates',
  ]),
  identity: new Set(['logging', 'shared']),
  telemetry: new Set(['logging', 'shared']),
  presentation: new Set(['config', 'machine', 'shared', 'state']),
  diagnostics: new Set(['presentation']),
  hooks: new Set(['adapters', 'integration', 'shared', 'state']),
  'mcp-server': new Set(['adapters', 'integration', 'logging', 'shared']),
  shared: new Set([]),
  providers: new Set(['shared', 'state']),
  verification: new Set(['adapters', 'providers', 'shared', 'state']),
  redaction: new Set(['logging', 'shared']),
  rendering: new Set(['shared', 'state', 'templates']),
  templates: new Set(['shared']),
};
