/**
 * @module documentation/demo-contract
 * @description CI guard for the Java demo contract.
 *
 * Live demo execution is intentionally not in CI: it needs an LLM-backed
 * OpenCode host. The demo *contract* is in CI. Every phase, command,
 * transition, and claim the demo teaches must match the canonical machine,
 * directive, and command authorities, so documentation drift fails here
 * instead of in front of an audience.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Phase } from '../../state/schema.js';
import type { Event, Phase as PhaseType } from '../../state/schema.js';
import { resolveTransition } from '../../machine/topology.js';
import { INSTALLED_COMMANDS } from '../../integration/installed-commands.js';
import { buildFinishCard } from '../../integration/status/status-finish.js';
import { getPolicyPreset } from '../../config/policy.js';
import { makeProgressedState } from '../../fixtures.js';

const DEMO_DIR = join(process.cwd(), 'demos', 'java-task-manager');
const read = (file: string): string => readFileSync(join(DEMO_DIR, file), 'utf8');

const DOCS: Readonly<Record<string, string>> = {
  'DEMO_SCRIPT.md': read('DEMO_SCRIPT.md'),
  'README.md': read('README.md'),
  'FALLBACK.md': read('FALLBACK.md'),
  'RESET.md': read('RESET.md'),
};

const DEMO_SCRIPT = DOCS['DEMO_SCRIPT.md']!;
const README = DOCS['README.md']!;
const RESET = DOCS['RESET.md']!;
const SNAPSHOT_SCRIPT = read('snapshot-demo.sh');
const PREFLIGHT_SCRIPT = read('run-demo-preflight.sh');

/**
 * Phase-like tokens, including the retired names. `\b` never matches inside
 * `PEER_REVIEW`/`IMPL_REVIEW`/`EVIDENCE_REVIEW` because `_` is a word
 * character, so this only finds whole tokens.
 */
function phaseLikeTokens(text: string): string[] {
  const pattern = new RegExp(
    `\\b(${['REVIEW_COMPLETE', 'REVIEW', ...Phase.options].join('|')})\\b`,
    'g',
  );
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

/** `/command` tokens written inside inline code spans; filesystem paths are skipped. */
function inlineCommandTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/`(\/[a-z][a-z-]*)([^`]*)`/g)) {
    const token = match[1]!;
    if ((match[2] ?? '').startsWith('/')) continue;
    tokens.add(token);
  }
  return [...tokens];
}

const INSTALLED_INVOCATIONS = new Set(
  INSTALLED_COMMANDS.map((definition) => definition.invocation.split(/\s+/)[0]!),
);

describe('java demo workflow contract', () => {
  it('uses only canonical phase names in the demo docs', () => {
    const canonical = new Set<string>(Phase.options);
    for (const [file, text] of Object.entries(DOCS)) {
      for (const token of phaseLikeTokens(text)) {
        expect(canonical.has(token), `${file} uses retired phase token "${token}"`).toBe(true);
      }
    }
  });

  it('documents the peer review flow without manual findings submission', () => {
    expect(DEMO_SCRIPT).toContain('PEER_REVIEW');
    expect(DEMO_SCRIPT).toContain('PEER_REVIEW_COMPLETE');
    expect(DEMO_SCRIPT).toContain('reviewDispatch');
    expect(DEMO_SCRIPT).not.toMatch(/submits?\s+`?reviewFindings/i);
  });

  it('documents the export commit as the only path from EXPORT_READY to COMPLETE', () => {
    expect(DEMO_SCRIPT).toContain('EXPORT_READY');
    expect(DEMO_SCRIPT).toContain('/export');
    expect(DEMO_SCRIPT).not.toContain('EVIDENCE_REVIEW → COMPLETE');
    expect(DEMO_SCRIPT).not.toMatch(
      /`?\/approve`?[^\n]{0,40}EVIDENCE_REVIEW\s*(?:→|-->)\s*COMPLETE/i,
    );
  });

  it('never claims /export and /archive are synonyms', () => {
    for (const [file, text] of Object.entries(DOCS)) {
      expect(text, file).not.toContain('Both call flowguard_archive');
    }
    expect(README).toContain('/archive');
    expect(README.toLowerCase()).toContain('terminal');
  });

  it('documents the canonical transitions that exist in the topology', () => {
    const transitions: ReadonlyArray<readonly [PhaseType, Event, PhaseType]> = [
      ['READY', 'PEER_REVIEW_SELECTED', 'PEER_REVIEW'],
      ['PEER_REVIEW', 'PEER_REVIEW_DONE', 'PEER_REVIEW_COMPLETE'],
      ['ARCH_REVIEW', 'APPROVE', 'ARCH_COMPLETE'],
      ['ARCH_REVIEW', 'REJECT', 'REJECTED'],
      ['PLAN_REVIEW', 'REJECT', 'REJECTED'],
      ['EVIDENCE_REVIEW', 'APPROVE', 'EXPORT_READY'],
      ['EVIDENCE_REVIEW', 'CHANGES_REQUESTED', 'IMPLEMENTATION'],
      ['IMPL_REVIEW', 'REVIEW_EXHAUSTED', 'EVIDENCE_REVIEW'],
      ['EXPORT_READY', 'EXPORT_MATERIALIZED', 'COMPLETE'],
    ];
    for (const [from, event, to] of transitions) {
      expect(resolveTransition(from, event), `${from} + ${event}`).toBe(to);
    }
    // The development flow's approval sequences through EXPORT_READY, never
    // straight to COMPLETE.
    expect(resolveTransition('EVIDENCE_REVIEW', 'APPROVE')).not.toBe('COMPLETE');
  });

  it('only references installed slash commands inside inline code', () => {
    for (const [file, text] of Object.entries(DOCS)) {
      for (const token of inlineCommandTokens(text)) {
        expect(
          INSTALLED_INVOCATIONS.has(token),
          `${file} references a phantom command ${token}`,
        ).toBe(true);
      }
    }
  });

  it('documents the governance override for an exhausted review', () => {
    expect(DEMO_SCRIPT).toContain('/override-approve');
    expect(DEMO_SCRIPT).toContain('GOVERNANCE_OVERRIDE_REQUIRED');
    // The override carries a mandatory non-empty rationale.
    expect(DEMO_SCRIPT).toContain('GOVERNANCE_OVERRIDE_RATIONALE_REQUIRED');
    expect(DEMO_SCRIPT).toMatch(
      /override-approve[^\n]*Begrundung|override-approve[^\n]*rationale/i,
    );
    for (const [file, text] of Object.entries(DOCS)) {
      expect(text.toLowerCase(), file).not.toContain('force-convergence');
    }
    // `/check` may appear as a compatibility note but never as a demo step.
    expect(DEMO_SCRIPT).not.toMatch(/\|\s*`\/check`/);
  });

  it('labels snapshots as workspace-only and never an authority restore', () => {
    expect(SNAPSHOT_SCRIPT.toLowerCase()).toContain('visual-only');
    expect(DEMO_SCRIPT.toLowerCase()).toMatch(/visual[- ]only/);
    expect(RESET.toLowerCase()).toContain('authority');
    expect(RESET).toMatch(/never/i);
  });

  it('keeps the preflight demo-contract checks in place', () => {
    for (const marker of [
      '/override-approve',
      'GOVERNANCE_OVERRIDE_REQUIRED',
      'EXPORT_READY',
      'PEER_REVIEW_COMPLETE',
      'Force-Convergence',
      'REVIEW_COMPLETE',
      'Both call flowguard_archive',
    ]) {
      expect(PREFLIGHT_SCRIPT.toLowerCase(), `preflight must check ${marker}`).toContain(
        marker.toLowerCase(),
      );
    }
  });

  it('states that live execution is not in CI but the contract is', () => {
    expect(README).toMatch(/not wired into CI/i);
  });

  it('backs the automatic validation claim with the executable runtime test', () => {
    // The demo says approval runs the active checks automatically. That claim
    // is only honest because the runtime implements it and proves it here;
    // a prose-only change must fail this guard.
    expect(DEMO_SCRIPT).toMatch(/automatic validation/i);
    const autoValidationTest = readFileSync(
      join(process.cwd(), 'src', 'integration', 'auto-validation.test.ts'),
      'utf8',
    );
    expect(autoValidationTest).toContain(
      'team plan approval runs every active check automatically and persists the evidence',
    );
    expect(autoValidationTest).toContain(
      'team /implement runs the post-implementation checks automatically and activates the review obligation',
    );
    expect(autoValidationTest).toContain(
      'solo plan convergence auto-approves into VALIDATION and runs the checks',
    );
  });

  it('documents the EXPORT_READY finish guidance that the runtime emits', () => {
    // Bind the demo statement to the runtime projection: at EXPORT_READY,
    // /export is required, so 'export evidence' is recommended while
    // 'create PR' and 'keep branch' are not_recommended.
    const card = buildFinishCard(makeProgressedState('EXPORT_READY'), getPolicyPreset('solo'));
    const statusOf = (action: string): string | undefined =>
      card.actionGuidance.find((guidance) => guidance.action === action)?.status;
    expect(statusOf('export evidence')).toBe('recommended');
    expect(statusOf('create PR')).toBe('not_recommended');
    expect(statusOf('keep branch')).toBe('not_recommended');

    // The demo must tell the same story.
    expect(DEMO_SCRIPT).toContain('`export evidence` ist `recommended`');
    expect(DEMO_SCRIPT).toContain('`create PR` und `keep branch` stehen auf `not_recommended`');
  });

  it('documents deterministic task/architecture inputs and the export completion projection', () => {
    // Bare `/task` and `/architecture` do not read files; the demo must pass
    // explicit input so the live run is deterministic.
    expect(DEMO_SCRIPT).toContain('/task Read TICKET.md');
    expect(DEMO_SCRIPT).toContain('/architecture Read ADR_TICKET.md');
    // `/export` surfaces its persisted completion evidence in the response.
    expect(DEMO_SCRIPT).toContain('exportCompletion');
  });
});
