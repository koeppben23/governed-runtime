/**
 * @module architecture/host-neutral-core.test
 * @description ADR-010 D1 guard: the FlowGuard core must not depend on host SDK
 * packages or make decisions from host names. Host specifics belong to adapters
 * (OpenCode plugin composition and host runtime files, CLI/installer, Claude
 * Code/Codex hooks, MCP server, templates/rendering of host install files).
 *
 * Rules (comment lines are skipped):
 *   R1 (zero tolerance): no `@opencode/*` or `@opencode-ai/*` import in core.
 *   R2 (counted, exact ratchet): non-comment lines that name OpenCode
 *      (case-insensitive `opencode`) or encode the OpenCode message-ID format
 *      (`/^msg` or `msg_`). Each remaining file has an exact budget and a reason.
 *      A new occurrence fails; a removed occurrence also fails until the budget
 *      is lowered, so the baseline can only shrink deliberately.
 *
 * `shared/hosts.ts` is the host-identity authority and is exempt.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectProductionSources } from '../support/production-source.js';
import { collectImportSpecifiers } from '../support/import-specifiers.js';
import {
  isRootCompositionFile,
  isRootHostRuntimeFile,
} from '../support/integration-placement-analyzer.js';

const SRC_ROOT = join(process.cwd(), 'src');

/** Top-level production modules that form the host-neutral core. */
const CORE_MODULES = new Set([
  'adapters',
  'archive',
  'audit',
  'config',
  'diagnostics',
  'discovery',
  'identity',
  'logging',
  'machine',
  'presentation',
  'providers',
  'rails',
  'redaction',
  'shared',
  'state',
  'telemetry',
  'verification',
]);

/** The host-identity authority (HOST_IDS, DEFAULT_HOST). */
const HOST_IDENTITY_AUTHORITY = 'shared/hosts.ts';

interface Allowance {
  readonly file: string;
  readonly count: number;
  readonly reason: string;
}

const PERSISTED_LOCATION =
  'persisted install/runtime location (~/.config/opencode, OPENCODE_CONFIG_DIR, .opencode/); moving it would be a user-data migration';
const PERSISTED_MESSAGE_ID =
  'persisted-evidence validation of the recorded host message-ID format; changing it would change which stored evidence is accepted';
const GLYPH_READ = 'reads presentation.opencode.glyphProfile directly (WS2-F: one owner)';
const HOST_TEXT = 'OpenCode-specific recovery/diagnostic text (WS2-G: neutral wording)';
const REVIEW_HOST_BRANCH = 'review dispatch decides from the host name (WS2-E: injected mode)';

/** Exact remaining host-specific lines in core. Lower a count when it shrinks. */
const HOST_SPECIFIC_ALLOWLIST: readonly Allowance[] = [
  {
    file: 'adapters/binding.ts',
    count: 5,
    reason: 'dead OpenCode context mapping (WS2-D: remove)',
  },
  {
    file: 'adapters/host-adapter.ts',
    count: 1,
    reason: 'HAI copy of the host list (WS2-E: HostId)',
  },
  { file: 'adapters/persistence-config.ts', count: 1, reason: PERSISTED_LOCATION },
  { file: 'adapters/persistence.ts', count: 2, reason: PERSISTED_LOCATION },
  { file: 'adapters/workspace/init.ts', count: 7, reason: PERSISTED_LOCATION },
  {
    file: 'config/flowguard-config.ts',
    count: 2,
    reason: 'persisted user-config key presentation.opencode (WS2-F: neutral key, compatible read)',
  },
  { file: 'config/reasons-infra.ts', count: 1, reason: HOST_TEXT },
  { file: 'config/reasons-precondition.ts', count: 6, reason: HOST_TEXT },
  { file: 'config/reasons-validation.ts', count: 5, reason: HOST_TEXT },
  { file: 'diagnostics/builders.ts', count: 1, reason: HOST_TEXT },
  {
    file: 'integration/review/dispatch/child-session-instruction.ts',
    count: 1,
    reason: REVIEW_HOST_BRANCH,
  },
  {
    file: 'integration/review/dispatch/native-review-capture.ts',
    count: 1,
    reason: 'mints OpenCode msg_ request IDs in core (WS2-E: capture host port)',
  },
  {
    file: 'integration/review/dispatch/orchestration-mode.ts',
    count: 4,
    reason: REVIEW_HOST_BRANCH,
  },
  {
    file: 'integration/review/dispatch/review-execution-projection.ts',
    count: 2,
    reason: 'hard-coded host name in tool output (WS2-E: remove)',
  },
  {
    file: 'integration/tools/architecture/architecture-review-response.ts',
    count: 1,
    reason: GLYPH_READ,
  },
  {
    file: 'integration/tools/implementation/implement-record.ts',
    count: 1,
    reason: 'local .opencode/ exclusion instead of the risk-path authority (WS2-E)',
  },
  { file: 'integration/tools/implementation/implement-review.ts', count: 1, reason: GLYPH_READ },
  { file: 'integration/tools/index.ts', count: 1, reason: GLYPH_READ },
  { file: 'integration/tools/plan/plan-response.ts', count: 1, reason: GLYPH_READ },
  { file: 'integration/tools/review-tool/completion.ts', count: 1, reason: GLYPH_READ },
  {
    file: 'integration/tools/review-tool/obligation-format.ts',
    count: 1,
    reason: REVIEW_HOST_BRANCH,
  },
  { file: 'integration/tools/simple/help-tool.ts', count: 1, reason: GLYPH_READ },
  { file: 'integration/tools/status/status-tool.ts', count: 1, reason: GLYPH_READ },
  { file: 'logging/file-sink.ts', count: 2, reason: PERSISTED_LOCATION },
  {
    file: 'state/evidence-assurance-internal.ts',
    count: 1,
    reason: 'OpenCodeSessionId type name (WS2-D: neutral name, same format)',
  },
  { file: 'state/evidence-audit.ts', count: 2, reason: 'uses OpenCodeSessionId (WS2-D)' },
  { file: 'state/evidence-binding.ts', count: 2, reason: 'uses OpenCodeSessionId (WS2-D)' },
  { file: 'state/evidence-review-invocation.ts', count: 1, reason: PERSISTED_MESSAGE_ID },
  { file: 'state/review-message-capture.ts', count: 1, reason: PERSISTED_MESSAGE_ID },
  {
    file: 'state/risk-path-classifier.ts',
    count: 5,
    reason:
      'classifies agent control-plane paths in the user repository for every host; no runtime host branch',
  },
];

interface SourceFile {
  readonly rel: string;
  readonly content: string;
}

function isCoreFile(rel: string): boolean {
  const top = rel.split('/')[0] ?? '';
  if (CORE_MODULES.has(top)) return rel !== HOST_IDENTITY_AUTHORITY;
  if (top !== 'integration') return false;
  return !isRootCompositionFile(rel) && !isRootHostRuntimeFile(rel);
}

function isCommentLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

const HOST_SDK_IMPORT = /^@opencode(-ai)?\//;
const HOST_SPECIFIC_LINE = /opencode|\/\^msg|\bmsg_/i;

function sdkImportViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) =>
    collectImportSpecifiers(file.content)
      .filter((specifier) => HOST_SDK_IMPORT.test(specifier.module))
      .map((specifier) => `${file.rel}: ${specifier.module}`),
  );
}

function hostSpecificCounts(files: readonly SourceFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    let count = 0;
    for (const line of file.content.split('\n'))
      if (!isCommentLine(line) && HOST_SPECIFIC_LINE.test(line)) count++;
    if (count > 0) counts.set(file.rel, count);
  }
  return counts;
}

function budgetViolations(
  counts: ReadonlyMap<string, number>,
  allowlist: readonly Allowance[],
): string[] {
  const out: string[] = [];
  for (const [rel, count] of counts) {
    const budget = allowlist.find((entry) => entry.file === rel)?.count ?? 0;
    if (count !== budget) out.push(`${rel}: ${count} host-specific line(s); budget ${budget}`);
  }
  for (const entry of allowlist)
    if (!counts.has(entry.file)) out.push(`${entry.file}: budget ${entry.count} but no occurrence`);
  return out;
}

describe('host-neutral core (ADR-010 D1)', () => {
  const core = collectProductionSources(SRC_ROOT).filter((file) => isCoreFile(file.rel));

  it('scans a non-trivial core', () => {
    expect(core.length).toBeGreaterThan(300);
    expect(core.some((file) => file.rel.startsWith('integration/review/'))).toBe(true);
    expect(core.some((file) => file.rel === 'integration/plugin.ts')).toBe(false);
  });

  it('R1: core imports no host SDK package', () => {
    expect(sdkImportViolations(core)).toEqual([]);
  });

  it('R2: host-specific lines in core match the exact shrinking allowlist', () => {
    expect(budgetViolations(hostSpecificCounts(core), HOST_SPECIFIC_ALLOWLIST)).toEqual([]);
  });

  it('every allowlist entry is a core file with a reason', () => {
    for (const entry of HOST_SPECIFIC_ALLOWLIST) {
      expect(isCoreFile(entry.file), entry.file).toBe(true);
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
    }
  });

  describe('negative fixtures prove the detectors fire', () => {
    it('R1 flags a host SDK import', () => {
      const fixture = [
        { rel: 'state/rogue.ts', content: "import type { X } from '@opencode/client';" },
      ];
      expect(sdkImportViolations(fixture)).toHaveLength(1);
    });

    it('R2 flags a new host-name branch and ignores comments', () => {
      const fixture = [
        { rel: 'rails/rogue.ts', content: "// opencode only\nif (host === 'opencode') run();" },
      ];
      expect(budgetViolations(hostSpecificCounts(fixture), [])).toEqual([
        'rails/rogue.ts: 1 host-specific line(s); budget 0',
      ]);
    });

    it('R2 flags a stale budget after an occurrence is removed', () => {
      expect(
        budgetViolations(new Map(), [{ file: 'state/x.ts', count: 1, reason: PERSISTED_LOCATION }]),
      ).toEqual(['state/x.ts: budget 1 but no occurrence']);
    });
  });
});
