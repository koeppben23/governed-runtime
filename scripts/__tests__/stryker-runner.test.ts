/** Native runner contract replacing the removed dependency-artifact patch. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
describe('native Stryker/Vitest runner', () => {
  it('uses the supported fork pool for every profile, without rewriting node_modules', () => {
    const profiles = readdirSync(root).filter((file) => /^stryker.*\.json$/.test(file));
    expect(profiles).toHaveLength(8);
    for (const file of profiles) {
      const config = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
      expect(config.vitest.pool, file).toBe('forks');
    }
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.mutation).toBe('stryker run');
  });

  it('the installed runner preserves the actual nested Vitest 5 test identity', async () => {
    const helpers = await import(
      pathToFileURL(
        resolve(root, 'node_modules/@stryker-mutator/vitest-runner/dist/src/test-helpers.js'),
      ).href
    );
    const test = {
      name: 'rejects foreign evidence',
      suite: { name: 'negative', suite: { name: 'review' } },
      file: { filepath: '/fixture/review.test.ts' },
    };
    expect(helpers.toRawTestId(test, helpers.VITEST_MODERN_TEST_NAME_SEPARATOR)).toBe(
      '/fixture/review.test.ts#review > negative > rejects foreign evidence',
    );
  });
});
