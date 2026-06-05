/**
 * @module documentation/__tests__/generate-docs-fail-closed
 * @description Guards docs generation against swallowed file update failures.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('scripts/generate-docs fail-closed behavior', () => {
  it('exits non-zero when the real entrypoint hits a forced document read failure', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'fg-generate-docs-test-'));
    const preloadPath = join(tempDir, 'force-read-failure.mjs');

    writeFileSync(
      preloadPath,
      `import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function readFileSyncWithForcedDocFailure(file, ...args) {
  const filePath = String(file);
  if (filePath.endsWith('/README.md') || filePath.endsWith('\\\\README.md')) {
    throw new Error('forced README failure');
  }
  return originalReadFileSync.call(this, file, ...args);
};
syncBuiltinESMExports();
`,
      'utf-8',
    );

    try {
      const result = spawnSync(process.execPath, ['--import', preloadPath, 'scripts/generate-docs.js'], {
        cwd: join(__dirname, '..', '..', '..'),
        encoding: 'utf-8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Error updating README.md: forced README failure');
      expect(result.stderr).toContain('Documentation generation failed; see errors above.');
      expect(result.stdout).not.toContain('synced across all documentation');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
