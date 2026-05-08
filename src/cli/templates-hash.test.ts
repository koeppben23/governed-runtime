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
    // Refreshed in P9a: webfetch contradiction fixed — reviewer frontmatter
    // has `webfetch: deny` but the Content Review section told reviewers to
    // use `webfetch`. P9a removed `webfetch` from the Content Review tool list
    // and replaced it with "provided content and available read, glob, grep".
    // See src/templates/mandates.ts:369 (Content Review section).
    //
    // Predecessor: F13 slice 4 extended REVIEWER_AGENT with ADR review criteria.
    // Predecessor: P1.3 slice 3 added the validity-conditions section.
    //
    // Cross-session compatibility: this hash gates ONLY the template-body
    // byte-stability of REVIEWER_AGENT (the markdown a CLI install writes
    // to .opencode/agent/flowguard-reviewer.md). It is independent from
    // REVIEW_MANDATE_DIGEST (src/integration/review-assurance.ts:24), which
    // is sha256(REVIEWER_AGENT) at module-load time.
    //
    // This P9a slice modifies REVIEWER_AGENT (the Content Review section of
    // mandates.ts), therefore both the template-body hash AND the runtime
    // REVIEW_MANDATE_DIGEST change. Persisted obligations from prior sessions
    // that reference the old mandateDigest will fail validation — the user
    // must re-hydrate or re-create affected sessions.
    //
    // This is the expected behaviour: the changed text hardens the manual
    // fallback contract so copied attestation fields are diagnostic only until
    // FlowGuard persists matching ReviewInvocationEvidence.
    expect(sha256(REVIEWER_AGENT)).toBe(
      '3bd9a4e14bea34a0a694a30737ddff727baf9dfcc14abc5b08b89bfc406580a0',
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
    // This hash gates ONLY the byte-stability of the markdown a CLI install
    // writes to .opencode/command/*.md. It is independent from any runtime
    // mandate digest.
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    expect(sha256(commandsJson)).toBe(
      '8183def7c249350a1a2073365b52fd9c0390fabc1f2b1f18c2e5dcebbb16ed20',
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
