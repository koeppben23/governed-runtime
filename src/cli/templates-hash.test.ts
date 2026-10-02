/**
 * @module templates-hash.test
 * @description Golden-manifest stability test for template exports.
 *
 * The committed golden artifact is `scripts/template-hashes.json`. This suite
 * recomputes every hash from the compiled template exports and fails on drift;
 * `npm run generate:template-hashes` refreshes the manifest explicitly (it
 * re-runs this file with `TEMPLATE_HASHES_WRITE=1`). The comparison is never a
 * self-compare: the test hashes the live templates and compares against the
 * committed bytes.
 *
 * @test-policy HAPPY — hash verification
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  FLOWGUARD_MANDATES_KERNEL,
  REVIEWER_AGENT,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
} from './templates.js';
import {
  TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
  TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
  TOOL_FLOWGUARD_RUN_CHECK,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_EXPORT,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE,
} from '../integration/tool-names.js';

const MANIFEST_URL = new URL('../../scripts/template-hashes.json', import.meta.url);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function computeTemplateHashes(): Record<string, string> {
  return {
    toolWrapper: sha256(TOOL_WRAPPER),
    pluginWrapper: sha256(PLUGIN_WRAPPER),
    flowguardMandatesKernel: sha256(FLOWGUARD_MANDATES_KERNEL),
    reviewerAgent: sha256(REVIEWER_AGENT),
    opencodeJsonTemplate: sha256(OPENCODE_JSON_TEMPLATE('flowguard-mandates.md')),
    packageJsonTemplate: sha256(PACKAGE_JSON_TEMPLATE('1.2.3')),
    commands: sha256(JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort())),
  };
}

if (process.env.TEMPLATE_HASHES_WRITE === '1') {
  writeFileSync(MANIFEST_URL, `${JSON.stringify(computeTemplateHashes(), null, 2)}\n`, 'utf8');
}

describe('TEMPLATE_HASH_STABILITY', () => {
  it('golden hash manifest matches every template byte-for-byte', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8')) as Record<string, string>;
    const expected = computeTemplateHashes();

    expect(Object.keys(manifest).sort()).toEqual(Object.keys(expected).sort());
    for (const [key, hash] of Object.entries(expected)) {
      expect(manifest[key], `${key} drifted; refresh with generate:template-hashes`).toBe(hash);
    }
  });

  it('TOOL_WRAPPER exports run_check instead of removed validate tool', () => {
    expect(TOOL_WRAPPER).toContain('run_check');
    expect(TOOL_WRAPPER).not.toContain('  validate,');
  });

  it('all 26 commands present', () => {
    const expected = [
      'abort.md',
      'approve.md',
      'architecture.md',
      'archive.md',
      'check.md',
      'commands.md',
      'continue.md',
      'export.md',
      'finish.md',
      'help.md',
      'hydrate.md',
      'implement.md',
      'override-approve.md',
      'plan.md',
      'reconcile-mutation-episode.md',
      'reject.md',
      'request-changes.md',
      'resolve-implementation-challenge.md',
      'review-decision.md',
      'review.md',
      'start.md',
      'status.md',
      'task.md',
      'ticket.md',
      'validate.md',
      'why.md',
    ];
    expect(Object.keys(COMMANDS).sort()).toEqual(expected);
  });

  it('TOOL_WRAPPER re-exports every canonical FlowGuard tool (OpenCode surface completeness)', () => {
    const canonicalToolNames = [
      TOOL_FLOWGUARD_STATUS,
      TOOL_FLOWGUARD_HYDRATE,
      TOOL_FLOWGUARD_TICKET,
      TOOL_FLOWGUARD_PLAN,
      TOOL_FLOWGUARD_DECISION,
      TOOL_FLOWGUARD_IMPLEMENT,
      TOOL_FLOWGUARD_REVIEW_IMPLEMENTATION,
      TOOL_FLOWGUARD_RESOLVE_IMPLEMENTATION_CHALLENGE,
      TOOL_FLOWGUARD_RUN_CHECK,
      TOOL_FLOWGUARD_REVIEW,
      TOOL_FLOWGUARD_CONTINUE,
      TOOL_FLOWGUARD_ABORT,
      TOOL_FLOWGUARD_ARCHIVE,
      TOOL_FLOWGUARD_EXPORT,
      TOOL_FLOWGUARD_ARCHITECTURE,
      TOOL_FLOWGUARD_HELP,
      TOOL_FLOWGUARD_OBSERVE_REPOSITORY,
      TOOL_FLOWGUARD_RECONCILE_MUTATION_EPISODE,
    ];

    const exportBlock = TOOL_WRAPPER.match(/export\s*\{([^}]*)\}/);
    expect(exportBlock, 'TOOL_WRAPPER must contain an export block').not.toBeNull();
    const exportedIdentifiers = new Set(
      exportBlock![1]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

    const missing = canonicalToolNames
      .map((toolName) => toolName.replace(/^flowguard_/, ''))
      .filter((exportName) => !exportedIdentifiers.has(exportName));

    expect(
      missing,
      `TOOL_WRAPPER is missing re-exports for: ${missing.join(', ')}. ` +
        `Add them to src/templates/wrappers/index.ts or OpenCode cannot call these tools.`,
    ).toEqual([]);

    const canonicalExportNames = new Set(
      canonicalToolNames.map((t) => t.replace(/^flowguard_/, '')),
    );
    const stray = [...exportedIdentifiers].filter((id) => !canonicalExportNames.has(id));
    expect(
      stray,
      `TOOL_WRAPPER exports unexpected identifiers (not canonical tools): ${stray.join(', ')}`,
    ).toEqual([]);
  });

  it('every TOOL_WRAPPER export exists in the integration barrel (installed package surface)', async () => {
    const exportBlock = TOOL_WRAPPER.match(/export\s*\{([^}]*)\}/);
    expect(exportBlock, 'TOOL_WRAPPER must contain an export block').not.toBeNull();
    const wrapperExports = exportBlock![1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const barrel = await fs.readFile(
      path.join(process.cwd(), 'src', 'integration', 'index.ts'),
      'utf-8',
    );
    const barrelExportBlock = barrel.match(/export\s*\{([\s\S]*?)\}\s*from '\.\/tools\/index\.js'/);
    expect(barrelExportBlock, 'integration barrel must re-export the tools').not.toBeNull();
    const barrelExports = new Set(
      barrelExportBlock![1]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

    const missing = wrapperExports.filter((id) => !barrelExports.has(id));
    expect(
      missing,
      `@flowguard/core/integration is missing exports referenced by TOOL_WRAPPER: ${missing.join(', ')}. ` +
        `Add them to src/integration/index.ts or the OpenCode tool scan fails.`,
    ).toEqual([]);
  });
});
