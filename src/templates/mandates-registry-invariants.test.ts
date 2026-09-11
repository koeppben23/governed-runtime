import { describe, expect, it } from 'vitest';
import { FLOWGUARD_MANDATES_BODY, MANDATES_SECTION_DEFINITIONS } from './mandates.js';

describe('mandate registry invariants', () => {
  it('keeps section ids and priorities unique', () => {
    const ids = MANDATES_SECTION_DEFINITIONS.map((section) => section.id);
    const priorities = MANDATES_SECTION_DEFINITIONS.map((section) => section.priority);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('keeps declaration order identical to priority order used by projections', () => {
    const priorities = MANDATES_SECTION_DEFINITIONS.map((section) => section.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it('binds every declared heading to the canonical section bytes', () => {
    for (const section of MANDATES_SECTION_DEFINITIONS) {
      if (section.heading === null) {
        expect(section.id).toBe('grounding');
        expect(section.content).toMatch(/^# FlowGuard Agent Rules/);
      } else {
        expect(section.content.startsWith(section.heading)).toBe(true);
      }
    }
  });

  it('builds the full mandate body from the same registry order', () => {
    const expected = `${MANDATES_SECTION_DEFINITIONS.map((section) => section.content).join('\n\n')}\n\n---\n\n[End of v5 Agent Rules]\n`;
    expect(FLOWGUARD_MANDATES_BODY).toBe(expected);
  });
});
