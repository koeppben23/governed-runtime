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
      '8c2caa5209d7416463536b1c8b0ea3eee78de5eedf9746f60410db06d58a0ee5',
    );
  });

  it('PLUGIN_WRAPPER matches compiled output hash', () => {
    expect(sha256(PLUGIN_WRAPPER)).toBe(
      '7810a13de154b7b4c9c3f33fd4a2932d35f73db576705959f6c2d9bdda9b1313',
    );
  });

  it('FLOWGUARD_MANDATES_BODY matches compiled output hash', () => {
    expect(sha256(FLOWGUARD_MANDATES_BODY)).toBe(
      'e282828517bc7891b2113bd5272377143e2e67eb56d17d44effb3d77d1fd8bdc',
    );
  });

  it('REVIEWER_AGENT matches compiled output hash', () => {
    // Refreshed for #264: REVIEWER_AGENT no longer hardcodes sampling
    // parameters in frontmatter. Removing `temperature: 0.1` changes both the
    // installed reviewer markdown and the runtime REVIEW_MANDATE_DIGEST.
    // Existing sessions with obligations bound to the previous digest must be
    // re-hydrated or re-created.
    expect(sha256(REVIEWER_AGENT)).toBe(
      '4ac316e4f293b39cd7984283fc0f72021d6012c5843198df45fa37469e47b4ca',
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
    // Refreshed for P35-fix: command templates now pin `agent: build` in
    // frontmatter for plan, implement, review, and architecture commands.
    // This ensures FlowGuard governance runs under the build agent's
    // permission.task restrictions regardless of active primary agent.
    //
    // Refreshed for reviewCard presentation mandate: plan, implement,
    // architecture, and review commands now have dedicated ## Presentation
    // sections with mandatory verbatim display instructions and reviewCard
    // in Done-when. This ensures LLMs cannot skip or summarize reviewCard.
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    expect(sha256(commandsJson)).toBe(
      '0df83521211e25232a69afc6c45eb952a624329eee2f4223f96b991dcc2e7d5a',
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
