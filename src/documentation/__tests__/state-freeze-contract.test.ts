import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CURRENT_SESSION_STATE_SCHEMA_VERSION } from '../../state/schema.js';

describe('released state contract documentation', () => {
  it('names the executable epoch and the predecessor upgrade-check requirement', () => {
    const release = readFileSync('docs/release-policy.md', 'utf8');
    const upgrade = readFileSync('docs/upgrade-rollback.md', 'utf8');
    expect(release).toContain(`${CURRENT_SESSION_STATE_SCHEMA_VERSION} state-contract freeze`);
    expect(release).toContain('preceding released');
    expect(release).toContain('flowguard inspect --upgrade-check');
    expect(upgrade).toContain(`schemaVersion: '${CURRENT_SESSION_STATE_SCHEMA_VERSION}'`);
    expect(upgrade).toContain('STATE_INTEGRITY_MISMATCH');
  });
});
