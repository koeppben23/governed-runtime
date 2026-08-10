import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderMarkdown } from './markdown.js';
import type { ReviewCardDocument } from './model.js';

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
});
