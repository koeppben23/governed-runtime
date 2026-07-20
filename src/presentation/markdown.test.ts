/**
 * @module presentation/markdown.test
 * @description Tests for the deterministic Markdown renderer.
 *
 * Invariants tested:
 * - No leading/trailing newline
 * - No trailing whitespace
 * - No triple-newline between structural blocks
 * - Exactly one conclusion
 * - Reason codes backtick-wrapped
 * - Null fields omitted
 * - Empty sections produce no output
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';
import { normalizedMarkdown } from './model.js';
import type {
  CompactCardDocument,
  ReviewCardDocument,
  DiagnosticCardDocument,
  PlanDocument,
  HelpDocument,
} from './model.js';

// ─── Invariant Helpers ─────────────────────────────────────────────────────────

function assertRendererInvariants(output: string): void {
  // No leading newline
  expect(output[0], 'Must not start with newline').not.toBe('\n');

  // No trailing newline
  expect(output[output.length - 1], 'Must not end with newline').not.toBe('\n');

  // No trailing whitespace on any line
  for (const line of output.split('\n')) {
    expect(line, `Trailing whitespace in line: "${line}"`).not.toMatch(/[ \t]+$/);
  }
}

function assertNoStructuralTripleNewline(output: string): void {
  // Structural blocks are separated by \n\n only.
  // Code-fence content may contain internal blank lines, so we check
  // outside code blocks.
  const outsideFence = output.replace(/```[\s\S]*?```/g, '<CODE>');
  expect(outsideFence).not.toContain('\n\n\n');
}

// ─── Basic Rendering ───────────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  it('produces empty string for document with no sections and no conclusion', () => {
    const doc: PlanDocument = {
      kind: 'plan_document',
      sections: [],
    };
    expect(renderMarkdown(doc)).toBe('');
  });

  it('renders a single keyValue section', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'keyValue',
          items: [
            { label: 'Phase', value: 'Planning' },
            { label: 'Policy', value: 'Team' },
          ],
        },
      ],
      conclusion: { kind: 'terminal', message: 'Done.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toBe('**Phase:** Planning\n**Policy:** Team\n\nDone.');
  });

  it('renders a title section as an H1 with canonical spacing', () => {
    const doc: ReviewCardDocument = {
      kind: 'review_card',
      sections: [
        { kind: 'title', text: 'FlowGuard Plan Review' },
        { kind: 'keyValue', items: [{ label: 'Status', value: 'Approved' }] },
      ],
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toBe('# FlowGuard Plan Review\n\n**Status:** Approved');
  });

  it('throws when a title section text is empty', () => {
    const doc: ReviewCardDocument = {
      kind: 'review_card',
      sections: [{ kind: 'title', text: '   ' }],
    };
    expect(() => renderMarkdown(doc)).toThrow(/TitleSection: text must not be empty/);
  });

  it('renders commandList with available and recommended actions', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'commandList',
          items: [
            { invocation: '/check', description: 'Run checks', visibility: 'available' },
            { invocation: '/approve', description: 'Approve', visibility: 'recommended' },
          ],
        },
      ],
      conclusion: {
        kind: 'next_action',
        action: { invocation: '/continue', description: 'Continue', visibility: 'recommended' },
      },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toContain('• `/check` — Run checks');
    expect(result).toContain('→ `/approve` — Approve');
    expect(result).toContain('→ `/continue` — Continue');
  });

  it('renders blocker with code and recovery', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'blocker',
          code: 'MISSING_EVIDENCE',
          text: 'Required evidence is missing.',
          recovery: 'Run /check to produce evidence.',
        },
      ],
      conclusion: {
        kind: 'next_action',
        action: { invocation: '/check', description: 'Run checks', visibility: 'recommended' },
      },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    assertNoStructuralTripleNewline(result);
    expect(result).toContain('`MISSING_EVIDENCE`');
    expect(result).toContain('⚠ **Blocked:**');
    expect(result).toContain('**Recovery:** Run /check to produce evidence.');
    expect(result).toContain('→ `/check` — Run checks');
  });

  it('renders checklist', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'checklist',
          label: 'Remaining checks',
          items: [
            { text: 'Lint', checked: false },
            { text: 'Tests', checked: true },
          ],
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toContain('**Remaining checks:**');
    expect(result).toContain('- [ ] Lint');
    expect(result).toContain('- [x] Tests');
  });

  it('renders code section with safe fence', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'code',
          language: 'typescript',
          content: 'const x = 1;\nconst y = 2;',
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toContain('```typescript\nconst x = 1;\nconst y = 2;\n```');
  });

  it('uses longer fence when content contains triple backtick', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'code',
          language: 'markdown',
          content: 'Here is a code block:\n```\ncode\n```',
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    // Must use 4 backticks since content contains 3
    expect(result).toContain('````markdown');
    expect(result).toContain('\n````');
  });

  it('renders text section verbatim', () => {
    const markdown = normalizedMarkdown('**Bold** text\n\nMore text');
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [{ kind: 'text', content: markdown }],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toBe('**Bold** text\n\nMore text\n\nEnd.');
  });

  it('renders notice section with warning level', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'notice',
          level: 'warning',
          heading: 'Discovery',
          message: 'Discovery data is degraded.',
          details: [
            { label: 'Reason', value: '2 collectors failed' },
            { label: 'Recovery', value: 'Run /hydrate' },
          ],
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toContain('⚠ Discovery data is degraded.');
    expect(result).toContain('**Reason:** 2 collectors failed');
    expect(result).toContain('**Recovery:** Run /hydrate');
  });

  it('renders decision_required with all available actions', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [],
      conclusion: {
        kind: 'decision_required',
        question: 'Choose a review verdict.',
        actions: [
          { invocation: '/approve', description: 'Accept', visibility: 'available' },
          { invocation: '/request-changes', description: 'Revise', visibility: 'available' },
          { invocation: '/reject', description: 'Reject', visibility: 'available' },
        ],
      },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toContain('Choose a review verdict.');
    expect(result).toContain('• `/approve` — Accept');
    expect(result).toContain('• `/request-changes` — Revise');
    expect(result).toContain('• `/reject` — Reject');
    expect(result).not.toContain('→');
  });

  it('throws when terminal conclusion message violates the structural contract', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [],
      // Trailing whitespace would otherwise silently break the document
      // invariants — the renderer must fail closed.
      conclusion: { kind: 'terminal', message: 'Done.   ' },
    };
    expect(() => renderMarkdown(doc)).toThrow(/Presentation contract violation/);
  });

  it('throws when terminal conclusion message is empty', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [],
      conclusion: { kind: 'terminal', message: '' },
    };
    expect(() => renderMarkdown(doc)).toThrow(/terminal message must not be empty/);
  });

  it('throws when decision_required question violates the structural contract', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [],
      conclusion: {
        kind: 'decision_required',
        question: 'Choose a verdict.\n',
        actions: [{ invocation: '/approve', description: 'Accept', visibility: 'available' }],
      },
    };
    expect(() => renderMarkdown(doc)).toThrow(/Presentation contract violation/);
  });

  it('renders findings section', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'findings',
          groups: [
            {
              severity: 'critical',
              label: 'Critical',
              items: [
                { category: 'correctness', message: 'Missing validation', location: 'src/foo.ts' },
              ],
            },
            {
              severity: 'warning',
              label: 'Warnings',
              items: [{ category: 'quality', message: 'Missing tests' }],
            },
          ],
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toContain('### Critical (1)');
    expect(result).toContain('- **correctness:** Missing validation `src/foo.ts`');
    expect(result).toContain('### Warnings (1)');
    expect(result).toContain('- **quality:** Missing tests');
  });

  it('renders artifactList', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'artifactList',
          items: [
            { slot: 'plan', label: 'Plan', status: 'complete', required: true },
            {
              slot: 'ticket',
              label: 'Ticket',
              status: 'missing',
              required: true,
              hint: 'Run /ticket',
            },
            { slot: 'adr', label: 'ADR', status: 'not_yet_required', required: false },
          ],
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toContain('✓ Plan (required)');
    expect(result).toContain('✗ Ticket (required) — Run /ticket');
    expect(result).toContain('— ADR');
  });

  it('renders review card without conclusion', () => {
    const doc: ReviewCardDocument = {
      kind: 'review_card',
      sections: [
        {
          kind: 'keyValue',
          items: [{ label: 'Status', value: 'Review complete' }],
        },
      ],
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toBe('**Status:** Review complete');
  });

  it('renders review card with conclusion', () => {
    const doc: ReviewCardDocument = {
      kind: 'review_card',
      sections: [
        {
          kind: 'keyValue',
          items: [{ label: 'Status', value: 'Review complete' }],
        },
      ],
      conclusion: {
        kind: 'next_action',
        action: { invocation: '/export', description: 'Export', visibility: 'recommended' },
      },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toContain('→ `/export` — Export');
  });

  it('renders diagnostic card', () => {
    const doc: DiagnosticCardDocument = {
      kind: 'diagnostic_card',
      sections: [
        {
          kind: 'keyValue',
          items: [{ label: 'Issue', value: 'Failed validation' }],
        },
      ],
      conclusion: { kind: 'terminal', message: 'Diagnostic complete.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    assertNoStructuralTripleNewline(result);
  });

  it('renders plan document (no conclusion)', () => {
    const doc: PlanDocument = {
      kind: 'plan_document',
      sections: [{ kind: 'text', content: normalizedMarkdown('## Objective\nBuild feature.') }],
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    expect(result).toBe('## Objective\nBuild feature.');
  });

  // ── Invariant Tests ──────────────────────────────────────────────────────

  it('no leading newline in any document type', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        { kind: 'keyValue', items: [{ label: 'A', value: '1' }] },
        { kind: 'keyValue', items: [{ label: 'B', value: '2' }] },
        { kind: 'keyValue', items: [{ label: 'C', value: '3' }] },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    expect(result[0]).not.toBe('\n');
  });

  it('no trailing newline in any document type', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [{ kind: 'keyValue', items: [{ label: 'A', value: '1' }] }],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    expect(result[result.length - 1]).not.toBe('\n');
  });

  it('no structural triple newline between sections', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        { kind: 'keyValue', items: [{ label: 'A', value: '1' }] },
        { kind: 'keyValue', items: [{ label: 'B', value: '2' }] },
        { kind: 'keyValue', items: [{ label: 'C', value: '3' }] },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertRendererInvariants(result);
    assertNoStructuralTripleNewline(result);
  });

  it('no trailing whitespace on any line', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        { kind: 'keyValue', items: [{ label: 'Phase', value: 'Planning' }] },
        { kind: 'keyValue', items: [{ label: 'Policy', value: 'Team' }] },
        { kind: 'keyValue', items: [{ label: 'Session', value: 'abc' }] },
      ],
      conclusion: {
        kind: 'next_action',
        action: { invocation: '/continue', description: 'Continue', visibility: 'recommended' },
      },
    };
    const result = renderMarkdown(doc);
    for (const line of result.split('\n')) {
      expect(line).not.toMatch(/[ \t]+$/);
    }
  });

  it('reason codes are always backtick-wrapped', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'blocker',
          code: 'VALIDATION_EVIDENCE_UNVERIFIED',
          text: 'Discovery is not trustworthy.',
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    expect(result).toContain('`VALIDATION_EVIDENCE_UNVERIFIED`');
  });

  it('omits empty sections entirely', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        { kind: 'keyValue', items: [] },
        { kind: 'commandList', items: [] },
        { kind: 'checklist', items: [] },
      ],
      conclusion: { kind: 'terminal', message: 'Only conclusion.' },
    };
    const result = renderMarkdown(doc);
    // Only the conclusion should appear
    expect(result).toBe('Only conclusion.');
  });

  it('exactly one conclusion appears', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [{ kind: 'keyValue', items: [{ label: 'A', value: '1' }] }],
      conclusion: {
        kind: 'next_action',
        action: { invocation: '/cmd', description: 'Do it', visibility: 'recommended' },
      },
    };
    const result = renderMarkdown(doc);
    const arrowCount = (result.match(/→/g) ?? []).length;
    // One recommendation from the conclusion
    const conclusionArrows = result.endsWith('→ `/cmd` — Do it');
    expect(arrowCount).toBe(1);
    expect(conclusionArrows).toBe(true);
  });

  it('non-command action renders without backticks', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [],
      conclusion: {
        kind: 'next_action',
        action: {
          invocation: null,
          description: 'Review the findings and decide.',
          visibility: 'recommended',
        },
      },
    };
    const result = renderMarkdown(doc);
    expect(result).toBe('→ — Review the findings and decide.');
  });

  it('structural triple-newline not present when sections use blocker + commandList', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        { kind: 'blocker', code: 'MISSING', text: 'Missing evidence.', recovery: 'Run /check' },
        {
          kind: 'commandList',
          items: [{ invocation: '/check', description: 'Verify', visibility: 'recommended' }],
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    assertNoStructuralTripleNewline(result);
  });

  it('code section with internal triple-backtick gets safe longer fence', () => {
    const doc: CompactCardDocument = {
      kind: 'compact_card',
      density: 'compact',
      sections: [
        {
          kind: 'code',
          language: 'markdown',
          content: 'Text with ````` inside',
        },
      ],
      conclusion: { kind: 'terminal', message: 'End.' },
    };
    const result = renderMarkdown(doc);
    // 5 backticks in content, need 6
    expect(result).toContain('``````markdown');
  });

  describe('embeddedMarkdown normalization', () => {
    it('demotes an embedded H1 body under a ## heading to H3 (no H1-under-H2 inversion)', () => {
      const doc: ReviewCardDocument = {
        kind: 'review_card',
        sections: [
          { kind: 'title', text: 'FlowGuard Plan Review' },
          {
            kind: 'embeddedMarkdown',
            heading: 'Proposed Plan',
            content: '# Implementation Plan\n\n## Approach\n\n- a',
          },
        ],
      };
      const result = renderMarkdown(doc);
      // Exactly one document-level H1 (the card title), body H1 demoted to H3.
      expect(result.match(/^# /gm)).toHaveLength(1);
      expect(result).toContain('## Proposed Plan\n\n### Implementation Plan');
      expect(result).toContain('#### Approach');
      // No embedded heading is shallower than the owning ## section.
      expect(result).not.toMatch(/## Proposed Plan\n\n# /);
    });

    it('demotes a label-only embed so its shallowest heading is at least H2', () => {
      const doc: HelpDocument = {
        kind: 'help_document',
        sections: [
          { kind: 'title', text: 'FlowGuard Help' },
          { kind: 'embeddedMarkdown', label: 'Current plan', content: '# Implementation Plan\n\nx' },
        ],
      };
      const result = renderMarkdown(doc);
      // Only the document title is H1; embedded plan H1 demoted to H2.
      expect(result.match(/^# /gm)).toHaveLength(1);
      expect(result).toContain('**Current plan:**\n## Implementation Plan');
    });

    it('preserves relative heading structure when demoting', () => {
      const doc: ReviewCardDocument = {
        kind: 'review_card',
        sections: [
          { kind: 'title', text: 'Card' },
          {
            kind: 'embeddedMarkdown',
            heading: 'Body',
            content: '# Top\n\n## Mid\n\n### Deep',
          },
        ],
      };
      const result = renderMarkdown(doc);
      expect(result).toContain('### Top');
      expect(result).toContain('#### Mid');
      expect(result).toContain('##### Deep');
    });

    it('strips trailing whitespace and collapses triple newlines in embedded content', () => {
      const doc: ReviewCardDocument = {
        kind: 'review_card',
        sections: [
          { kind: 'title', text: 'Card' },
          {
            kind: 'embeddedMarkdown',
            heading: 'Body',
            content: 'line with trailing space   \n\n\n\nnext block',
          },
        ],
      };
      const result = renderMarkdown(doc);
      expect(result).not.toMatch(/[ \t]+$/m);
      expect(result).not.toContain('\n\n\n');
    });

    it('preserves code-fence content verbatim (triple newlines and indentation exempt)', () => {
      const doc: ReviewCardDocument = {
        kind: 'review_card',
        sections: [
          { kind: 'title', text: 'Card' },
          {
            kind: 'embeddedMarkdown',
            heading: 'Body',
            content: '```ts\nconst x = 1;\n\n\n// keep\n```',
          },
        ],
      };
      const result = renderMarkdown(doc);
      expect(result).toContain('```ts\nconst x = 1;\n\n\n// keep\n```');
    });

    it('does not demote # inside a code fence', () => {
      const doc: ReviewCardDocument = {
        kind: 'review_card',
        sections: [
          { kind: 'title', text: 'Card' },
          {
            kind: 'embeddedMarkdown',
            heading: 'Body',
            content: '## Real heading\n\n```sh\n# a shell comment, not a heading\n```',
          },
        ],
      };
      const result = renderMarkdown(doc);
      expect(result).toContain('# a shell comment, not a heading');
      expect(result).toContain('### Real heading');
    });
  });
});
