/**
 * @module scripts/__tests__/mutation-workflow-contract
 * @description Guards the sharded mutation gate wiring. The final `mutation`
 * job must stay the admission aggregator; shards are implementation details and
 * must never let a missing, duplicate or failed shard pass as a release gate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const SHARDS = [0, 1, 2, 3, 4, 5, 6, 7];

describe('sharded mutation workflow contract', () => {
  for (const workflowPath of ['.github/workflows/release.yml', '.github/workflows/mutation.yml']) {
    describe(workflowPath, () => {
      const workflow = read(workflowPath);

      it('runs disjoint shards and keeps mutation as the admission aggregator', () => {
        expect(workflow).toContain('  mutation-shards:');
        expect(workflow).toContain('name: mutation-shard (${{ matrix.shard }})');
        expect(workflow).toContain(`shard: [${SHARDS.join(', ')}]`);
        expect(workflow).toContain('MUTATION_SHARD_COUNT: 8');
        expect(workflow).toContain('node scripts/mutation-shard.mjs --profile base');
        expect(workflow).toContain('--config-out "stryker-shard-${{ matrix.shard }}.conf.json"');
        expect(workflow).toContain(
          'npx --no-install stryker run "stryker-shard-${{ matrix.shard }}.conf.json"',
        );
        expect(workflow).toContain('  mutation:\n    name: mutation');
        expect(workflow).toContain('needs: mutation-shards');
        expect(workflow).toContain('if: always()');
        expect(workflow).toContain("needs.mutation-shards.result != 'success'");
      });

      it('merges all shard reports before running the unchanged admission gate', () => {
        expect(workflow).toContain('pattern: mutation-shard-*');
        expect(workflow).toContain('merge-multiple: true');
        expect(workflow).toContain('node scripts/merge-mutation-reports.mjs --profile base');
        expect(workflow).toContain('--shard-count "$MUTATION_SHARD_COUNT"');
        expect(workflow).toContain('--input-dir reports/mutation/shards');
        expect(workflow).toContain('--output reports/mutation/mutation.json');
        expect(workflow).toContain(
          'node scripts/verify-mutation-admission.mjs --profile base --write-profile-manifest',
        );
        expect(workflow).toContain(
          'node scripts/verify-mutation-admission.mjs --profile base --verify-profile-manifest --require-admitted',
        );
      });

      it('does not fall back to the single-run mutation command', () => {
        expect(workflow).not.toContain('run: npm run mutation');
      });
    });
  }

  it('keeps the release job gated by the mutation aggregator', () => {
    const release = read('.github/workflows/release.yml');
    expect(release).toContain(
      'needs: [preflight, verify, release-smoke, verify-runtime, mutation]',
    );
    expect(release).toContain('name: mutation-shard (${{ matrix.shard }})');
    expect(release).toContain('  mutation:\n    name: mutation');
  });

  it('keeps scheduled failure reporting on the final mutation job', () => {
    const mutation = read('.github/workflows/mutation.yml');
    const finalJob = mutation.slice(mutation.indexOf('  mutation:\n    name: mutation'));
    expect(finalJob).toContain("if: always() && github.event_name == 'schedule' && failure()");
    expect(finalJob).toContain('title="Scheduled workflow failed: ${{ github.workflow }}"');
  });
});
