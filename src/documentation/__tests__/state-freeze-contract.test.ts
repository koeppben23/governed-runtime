import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIVE_STATE_FINDING_CODES } from '../../adapters/workspace/upgrade-preflight-live-state.js';
import { defaultReasonRegistry } from '../../config/reasons.js';
import { CURRENT_SESSION_STATE_SCHEMA_VERSION } from '../../state/schema.js';

/** State-boundary codes the upgrade/rollback contract names for operators. */
const STATE_BOUNDARY_CODES = [
  'SESSION_STATE_INCOMPATIBLE',
  'POLICY_SNAPSHOT_INTEGRITY_MISMATCH',
  ...Object.values(LIVE_STATE_FINDING_CODES),
] as const;

describe('released state contract documentation', () => {
  it('names the executable epoch and the predecessor upgrade-check requirement', () => {
    const release = readFileSync('docs/release-policy.md', 'utf8');
    const upgrade = readFileSync('docs/upgrade-rollback.md', 'utf8');
    expect(release).toContain(`${CURRENT_SESSION_STATE_SCHEMA_VERSION} state-contract freeze`);
    expect(release).toContain('preceding released');
    expect(release).toContain('flowguard inspect --upgrade-check');
    expect(upgrade).toContain(`schemaVersion: '${CURRENT_SESSION_STATE_SCHEMA_VERSION}'`);
  });

  it('documents only state-boundary codes that the reason catalog registers', () => {
    const upgrade = readFileSync('docs/upgrade-rollback.md', 'utf8');
    const unregistered = STATE_BOUNDARY_CODES.filter(
      (code) => defaultReasonRegistry.get(code) === undefined,
    );
    expect(unregistered, 'register the code in src/config/reasons-*.ts').toEqual([]);
    const undocumented = STATE_BOUNDARY_CODES.filter((code) => !upgrade.includes(`\`${code}\``));
    expect(undocumented, 'name the code in docs/upgrade-rollback.md').toEqual([]);
  });
});
