/**
 * @module templates-hash.test
 * @description Hash-based stability test for template exports.
 *
 * Verifies that templates remain byte-for-byte identical after refactoring.
 * Uses SHA-256 hashes computed from the compiled template output.
 *
 * @test-policy STABILITY — hash verification
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  FLOWGUARD_MANDATES_BODY,
  REVIEWER_AGENT,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
} from './templates.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('TEMPLATE_HASH_STABILITY', () => {
  it('TOOL_WRAPPER matches compiled output hash', () => {
    expect(sha256(TOOL_WRAPPER)).toBe(
      'b4b460e0fd2575b450b774fb941f108248e0fa7637dcac5f1909025a044d0d7d',
    );
  });

  it('TOOL_WRAPPER exports run_check instead of removed validate tool', () => {
    expect(TOOL_WRAPPER).toContain('run_check');
    expect(TOOL_WRAPPER).not.toContain('  validate,');
  });

  it('PLUGIN_WRAPPER matches compiled output hash', () => {
    expect(sha256(PLUGIN_WRAPPER)).toBe(
      '7810a13de154b7b4c9c3f33fd4a2932d35f73db576705959f6c2d9bdda9b1313',
    );
  });

  it('FLOWGUARD_MANDATES_BODY matches compiled output hash', () => {
    // Refreshed for #265: mandates mirror policy-gated reduced ceremony rules.
    expect(sha256(FLOWGUARD_MANDATES_BODY)).toBe(
      '4e7e33309242f1c0e0267dcc247d8f700a4c15cf9bfba15fe07a99734cf60c5b',
    );
  });

  it('REVIEWER_AGENT matches compiled output hash', () => {
    // Refreshed for #245: multi-platform review orchestration added native
    // Claude/Codex reviewer renderers without changing the OpenCode reviewer
    // prompt structure. The JSON Output Format schema block remains closed.
    // This changes the runtime REVIEW_MANDATE_DIGEST.
    // Existing sessions with obligations bound to the previous digest must be
    // re-hydrated or re-created.
    expect(sha256(REVIEWER_AGENT)).toBe(
      'd30de30986a088760ee0178db067ae4b05edba7d238d21c632a09b23345ea142',
    );
  });

  it('OPENCODE_JSON_TEMPLATE matches compiled output hash', () => {
    const template = OPENCODE_JSON_TEMPLATE('flowguard-mandates.md');
    expect(sha256(template)).toBe(
      '1fc84e2ee553df018b6ee1af2c2beeaf9b11f86f82f43ee0019e09afa5afd45b',
    );
  });

  it('PACKAGE_JSON_TEMPLATE matches compiled output hash', () => {
    const template = PACKAGE_JSON_TEMPLATE('1.2.3');
    expect(sha256(template)).toBe(
      '9a09254c6abceacb655020b9c03b4a25bf7f5fa60b7e336fb36aa31e093ffc09',
    );
  });

  it('COMMANDS matches compiled output hash', () => {
    // Refreshed for #262: GOVERNANCE_RULES is now a projection from the
    // mandates Governance rules section, affecting all command templates.
    // Refreshed for #401: /review template now requires Discovery context
    // (health/drift) and NOT_VERIFIED correlation for PR/content review.
    // Refreshed for Item 2: plan/implement/architecture review templates now
    // capture Discovery context, pass it to the reviewer subagent, and require
    // NOT_VERIFIED correlation (parity with /review). Changes the COMMANDS hash.
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    expect(sha256(commandsJson)).toBe(
      '50dc4ea66b241fa74ef4f55db49b584ee2b621ae587d8514cf583d08dc4329e7',
    );
  });

  it('all 20 commands present', () => {
    const expected = [
      'abort.md',
      'approve.md',
      'architecture.md',
      'archive.md',
      'check.md',
      'continue.md',
      'export.md',
      'hydrate.md',
      'implement.md',
      'plan.md',
      'reject.md',
      'request-changes.md',
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
});
