import { describe, expect, it } from 'vitest';
import { hashText } from './hashing.js';
import { indexMarkdownSections, projectMarkdownHeadings } from './markdown-sections.js';

describe('indexMarkdownSections', () => {
  it('indexes duplicate headings by deterministic hierarchical sibling path', () => {
    const sections = indexMarkdownSections(
      '# Plan\nintro\n### Detail\nchild\n## Steps\nwork\n### Detail\nmore\n# Plan\nnext',
    );

    expect(
      sections.map(({ headingDepth, siblingIndex, headingText, sectionPath }) => ({
        headingDepth,
        siblingIndex,
        headingText,
        sectionPath,
      })),
    ).toEqual([
      {
        headingDepth: 1,
        siblingIndex: 1,
        headingText: 'Plan',
        sectionPath: [{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }],
      },
      {
        headingDepth: 3,
        siblingIndex: 1,
        headingText: 'Detail',
        sectionPath: [
          { headingDepth: 1, siblingIndex: 1, headingText: 'Plan' },
          { headingDepth: 3, siblingIndex: 1, headingText: 'Detail' },
        ],
      },
      {
        headingDepth: 2,
        siblingIndex: 1,
        headingText: 'Steps',
        sectionPath: [
          { headingDepth: 1, siblingIndex: 1, headingText: 'Plan' },
          { headingDepth: 2, siblingIndex: 1, headingText: 'Steps' },
        ],
      },
      {
        headingDepth: 3,
        siblingIndex: 1,
        headingText: 'Detail',
        sectionPath: [
          { headingDepth: 1, siblingIndex: 1, headingText: 'Plan' },
          { headingDepth: 2, siblingIndex: 1, headingText: 'Steps' },
          { headingDepth: 3, siblingIndex: 1, headingText: 'Detail' },
        ],
      },
      {
        headingDepth: 1,
        siblingIndex: 2,
        headingText: 'Plan',
        sectionPath: [{ headingDepth: 1, siblingIndex: 2, headingText: 'Plan' }],
      },
    ]);
  });

  it('binds each excerpt through its next same-or-shallower heading', () => {
    const sections = indexMarkdownSections(
      '# Plan\nintro\n## Detail\nchild\n### Nested\nmore\n## Steps\nwork',
    );
    const plan = sections[0]!;
    const detail = sections[1]!;
    const steps = sections[3]!;

    expect(plan.excerptText).toBe(
      '# Plan\nintro\n## Detail\nchild\n### Nested\nmore\n## Steps\nwork',
    );
    expect(detail.excerptText).toBe('## Detail\nchild\n### Nested\nmore');
    expect(steps.excerptText).toBe('## Steps\nwork');
    expect(detail.excerptDigest).toBe(hashText(detail.excerptText));
    expect(indexMarkdownSections('# Plan\nchanged')[0]!.excerptDigest).not.toBe(plan.excerptDigest);
  });

  it('ignores heading-shaped content inside backtick and tilde fences', () => {
    expect(
      indexMarkdownSections(
        '# Real\n```bash\n# not a section\n```\n~~~text\n## neither\n~~~\n## Next',
      ),
    ).toMatchObject([{ headingText: 'Real' }, { headingText: 'Next' }]);
  });
});

describe('projectMarkdownHeadings', () => {
  it('preserves the legacy H1-H3 PlanEvidence.sections projection', () => {
    expect(projectMarkdownHeadings('# Plan\n#### Internal\n### Detail\nplain\n## Steps')).toEqual([
      'Plan',
      'Detail',
      'Steps',
    ]);
  });
});
