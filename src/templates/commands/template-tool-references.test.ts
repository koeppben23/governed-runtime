/**
 * @module templates/commands/template-tool-references.test
 * @description Build-time guard: every flowguard_* tool name referenced in command
 * templates MUST be a registered tool. Prevents phantom-tool regressions like B4
 * (where /continue referenced a non-existent flowguard_continue).
 */

import { describe, expect, it } from 'vitest';

import {
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_VALIDATE,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
} from '../../integration/tool-names.js';
import { COMMANDS } from './index.js';

const REGISTERED_TOOLS: ReadonlySet<string> = new Set([
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_VALIDATE,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_ARCHIVE,
]);

const TOOL_REFERENCE_PATTERN = /flowguard_[a-z_]+/g;

describe('command templates: tool reference integrity', () => {
  it('every flowguard_* token in command templates resolves to a registered tool', () => {
    const violations: { template: string; phantom: string }[] = [];

    for (const [filename, body] of Object.entries(COMMANDS)) {
      const matches = body.match(TOOL_REFERENCE_PATTERN) ?? [];
      for (const ref of matches) {
        if (!REGISTERED_TOOLS.has(ref)) {
          violations.push({ template: filename, phantom: ref });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('continue.md does not reference the phantom flowguard_continue tool (B4)', () => {
    const body = COMMANDS['continue.md'];
    expect(body).toBeDefined();
    expect(body).not.toContain('flowguard_continue');
  });
});
