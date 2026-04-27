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
      'c127fa42dd08f79788fe9defde7c6d86290366e44f7dded4d76f1f9d20fa2ad2',
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
    expect(sha256(REVIEWER_AGENT)).toBe(
      'b3ddba51a17836f5f2e95f92854f34583a6c7d953653c5fb7b7a41ce8352dc13',
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
      'ad74e099d3dc23901df478e8b90bfb92e0627c127aee987e6e4955e8bdeaba22',
    );
  });

  it('COMMANDS matches compiled output hash', () => {
    const commandsJson = JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort());
    expect(sha256(commandsJson)).toBe(
      '93a6a63b963c85283cbfd0a417d5d7c54a368e83885aa77ad2c00c19225818b3',
    );
  });

  it('all 12 commands present', () => {
    const expected = [
      'hydrate.md',
      'status.md',
      'ticket.md',
      'plan.md',
      'continue.md',
      'implement.md',
      'validate.md',
      'review-decision.md',
      'review.md',
      'architecture.md',
      'abort.md',
      'archive.md',
    ];
    expect(Object.keys(COMMANDS)).toEqual(expected);
  });
});
