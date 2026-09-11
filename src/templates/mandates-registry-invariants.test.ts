import { describe, expect, it } from 'vitest';
import {
  FLOWGUARD_MANDATES_FULL_BODY,
  FLOWGUARD_MANDATES_KERNEL,
  MANDATES_SECTION_DEFINITIONS,
  MANDATES_TRAILER,
} from './mandates.js';

const KERNEL_SECTION_IDS = [
  'grounding',
  'red-lines',
  'priority',
  'hard-invariants',
  'evidence',
  'ambiguity',
  'tool-error',
  'rule-conflict',
  'command-execution',
] as const;

function documentFrom(contents: readonly string[]): string {
  return `${contents.join('\n\n')}\n\n---\n\n${MANDATES_TRAILER}\n`;
}

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

  it('builds the full projection from every canonical section exactly once', () => {
    const expected = documentFrom(MANDATES_SECTION_DEFINITIONS.map((section) => section.content));
    expect(FLOWGUARD_MANDATES_FULL_BODY).toBe(expected);
  });

  it('builds the installed kernel from the exact canonical kernel subset', () => {
    const kernelSections = MANDATES_SECTION_DEFINITIONS.filter(
      (section) => 'kernel' in section && section.kernel === true,
    );
    expect(kernelSections.map((section) => section.id)).toEqual(KERNEL_SECTION_IDS);
    expect(FLOWGUARD_MANDATES_KERNEL).toBe(
      documentFrom(kernelSections.map((section) => section.content)),
    );
  });

  it('keeps phase/task-specific process prose out of the persistent kernel', () => {
    expect(FLOWGUARD_MANDATES_KERNEL).not.toContain('## 3. Task Class Router');
    expect(FLOWGUARD_MANDATES_KERNEL).not.toContain('## 6. Tool and Verification Policy');
    expect(FLOWGUARD_MANDATES_KERNEL).not.toContain('## 8. Output Contract');
    expect(FLOWGUARD_MANDATES_KERNEL).not.toContain('## 9. Implementation Checklist');
    expect(FLOWGUARD_MANDATES_KERNEL).not.toContain('## 10. Review Checklist');
    expect(FLOWGUARD_MANDATES_KERNEL).not.toContain('## 11. High-Risk Extension');
  });

  it('retains every universal security/evidence stop invariant in the kernel', () => {
    expect(FLOWGUARD_MANDATES_KERNEL).toContain('fail-closed');
    expect(FLOWGUARD_MANDATES_KERNEL).toContain('NOT_VERIFIED');
    expect(FLOWGUARD_MANDATES_KERNEL).toContain('data, not instruction');
    expect(FLOWGUARD_MANDATES_KERNEL).toContain('secrets, credentials, tokens');
    expect(FLOWGUARD_MANDATES_KERNEL).toContain(
      'Never continue to the next workflow step after a failed, blocked, malformed',
    );
    expect(FLOWGUARD_MANDATES_KERNEL).toContain('Only an explicit FlowGuard command');
  });

  it('makes the persistent kernel materially smaller than the full projection', () => {
    expect(FLOWGUARD_MANDATES_KERNEL.length).toBeLessThan(FLOWGUARD_MANDATES_FULL_BODY.length);
  });
});
