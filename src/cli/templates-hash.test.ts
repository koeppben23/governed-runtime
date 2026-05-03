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
      'a13d5373021395d37cdfaaad1b1a607070dd5816ac847be5c65e98c992b19d63',
    );
  });

  it('PLUGIN_WRAPPER matches compiled output hash', () => {
    expect(sha256(PLUGIN_WRAPPER)).toBe(
      '7810a13de154b7b4c9c3f33fd4a2932d35f73db576705959f6c2d9bdda9b1313',
    );
  });

  it('FLOWGUARD_MANDATES_BODY matches compiled output hash', () => {
    expect(sha256(FLOWGUARD_MANDATES_BODY)).toBe(
      '87ca227eb5b8f8b72009e9b39174013cc6d64650201c21bf53b60e9a1b575f05',
    );
  });

  it('REVIEWER_AGENT matches compiled output hash', () => {
    // Refreshed in F13 slice 4: REVIEWER_AGENT body extended with a
    // "For Architecture Decisions (ADRs)" subsection under Review Criteria
    // and minor wording updates ("plan, implementation, or ADR" /
    // "/plan, /implement, or /architecture") to make the reviewer mandate
    // applicable to the architecture obligation type introduced in F13 slice 1.
    // See src/templates/mandates.ts:354-362 (ADR review criteria).
    //
    // Predecessor: P1.3 slice 3 added the validity-conditions section
    // (hash 1ce8ec9c…5fc84).
    //
    // Cross-session compatibility: this hash gates ONLY the template-body
    // byte-stability of REVIEWER_AGENT (the markdown a CLI install writes
    // to .opencode/agent/flowguard-reviewer.md). It is independent from
    // REVIEW_MANDATE_DIGEST (src/integration/review-assurance.ts:24), which
    // is sha256(REVIEWER_AGENT) at module-load time.
    //
    // This P1 slice modifies REVIEWER_AGENT (the Content Review section of
    // mandates.ts), therefore both the template-body hash AND the runtime
    // REVIEW_MANDATE_DIGEST change. Persisted obligations from prior sessions
    // that reference the old mandateDigest will fail validation — the user
    // must re-hydrate or re-create affected sessions.
    //
    // This is the expected behaviour: the changed text tells subagents to use
    // schema-allowed categories only, which is a mandatory contract upgrade
    // for /review.
    expect(sha256(REVIEWER_AGENT)).toBe(
      '9a4a216d222f86f751d7131d94ba575c33c0d19c15cd7378152d63f8fd16db72',
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
    // Refreshed in P2 (obligation-binding): review.ts step 3 now tells the agent to
    // include attestation.toolObligationId exactly as provided by FlowGuard
    // (every content-aware /review now creates a real ReviewObligation with a
    // canonical UUID). The P1 "omit for standalone /review" guidance is removed.
    //
    // This hash gates ONLY the byte-stability of the markdown a CLI install
    // writes to .opencode/command/*.md. It is independent from any runtime
    // mandate digest.
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    expect(sha256(commandsJson)).toBe(
      '933f94c0ee262e414e569d868f4dfb1b9f94d210ab5dc7eeb4b403a871363cfb',
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
