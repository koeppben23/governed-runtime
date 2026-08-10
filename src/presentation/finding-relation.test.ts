import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderMarkdown } from './markdown.js';
import { projectFindingRelation } from './finding-relation.js';
import type { FindingRelationPresentation, ReviewCardDocument } from './model.js';

async function readGolden(name: string): Promise<string> {
  return (
    await readFile(resolve(__dirname, '..', '..', 'testdata', 'presentation', name), 'utf-8')
  ).trimEnd();
}

describe('finding relation presentation', () => {
  it('renders structured repository and artifact relations without losing locations', async () => {
    const document: ReviewCardDocument = {
      kind: 'review_card',
      sections: [
        {
          kind: 'findings',
          heading: 'Findings',
          detail: 'expanded',
          groups: [
            {
              severity: 'major',
              label: 'Major',
              items: [
                {
                  category: 'correctness',
                  message: 'Range handling is incomplete',
                  subjects: [
                    {
                      kind: 'repository_location',
                      location: { path: 'src/range.ts', revision: 'base', line: 4, endLine: 9 },
                    },
                    {
                      kind: 'artifact_section',
                      artifactKind: 'plan',
                      sectionPath: [{ headingText: 'Implementation' }, { headingText: 'Ranges' }],
                    },
                    {
                      kind: 'artifact_section',
                      artifactKind: 'adr',
                      sectionPath: [{ headingText: 'Decision' }],
                    },
                  ],
                  evidence: [
                    { path: 'src/range.ts', revision: 'head', line: 10 },
                    { path: 'test/range.test.ts', revision: 'head' },
                  ],
                },
                { category: 'quality', message: 'Legacy finding' },
              ],
            },
          ],
        },
      ],
    };

    expect(renderMarkdown(document)).toBe(await readGolden('finding-relation-presentation.md'));
  });

  it('leaves legacy findings neutral when no relation was provided', () => {
    const document: ReviewCardDocument = {
      kind: 'review_card',
      sections: [
        {
          kind: 'findings',
          groups: [
            {
              severity: 'major',
              label: 'Major',
              items: [{ category: 'quality', message: 'Legacy' }],
            },
          ],
        },
      ],
    };

    const markdown = renderMarkdown(document);
    expect(markdown).toContain('- **quality:** Legacy');
    expect(markdown).not.toContain('Affected:');
    expect(markdown).not.toContain('Evidence:');
  });

  it('copies only display fields from canonical relation values', () => {
    const relation = {
      subjectAnchors: [
        {
          kind: 'artifact_section',
          artifactKind: 'plan',
          artifactDigest: 'not-for-presentation',
          sectionPath: [{ headingText: 'Implementation', headingDepth: 2, siblingIndex: 1 }],
        },
      ],
      evidenceLocations: [],
    } as unknown as FindingRelationPresentation;

    const projected = projectFindingRelation(relation);
    expect(projected).toHaveProperty('subjects');
    if ('subjects' in projected) {
      expect(projected.subjects[0]).not.toHaveProperty('artifactDigest');
      expect(projected.subjects[0]).toHaveProperty('sectionPath.0.headingText', 'Implementation');
      expect(projected.subjects[0]).not.toHaveProperty('sectionPath.0.headingDepth');
      expect(projected.subjects[0]).not.toHaveProperty('sectionPath.0.siblingIndex');
    }
  });
});
