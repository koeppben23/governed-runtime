import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { uninstall } from './install.js';
import { INSTALL_OWNERSHIP_FILENAME } from './install-ownership.js';
import { repoArgs, setupCliTestEnvironment, tmpDir } from './install-test-helpers.test.js';

setupCliTestEnvironment();

describe('uninstall ownership fail-closed', () => {
  it('preserves an invalid ownership manifest and refuses destructive cleanup', async () => {
    const target = path.join(tmpDir, '.opencode');
    await fs.mkdir(target, { recursive: true });
    const manifestPath = path.join(target, INSTALL_OWNERSHIP_FILENAME);
    const malformed = '{"schemaVersion":999,"unexpected":true}\n';
    await fs.writeFile(manifestPath, malformed, 'utf-8');

    const sentinelPath = path.join(target, 'customer-sentinel.txt');
    await fs.writeFile(sentinelPath, 'customer-owned\n', 'utf-8');

    const result = await uninstall(repoArgs({ action: 'uninstall' }));

    expect(result.errors.join('\n')).toContain('ownership manifest');
    expect(result.errors.join('\n')).toContain('refusing uninstall');
    expect(existsSync(manifestPath)).toBe(true);
    expect(await fs.readFile(manifestPath, 'utf-8')).toBe(malformed);
    expect(await fs.readFile(sentinelPath, 'utf-8')).toBe('customer-owned\n');
  });

  it('preserves package.json byte-for-byte when dependency ownership is not proven', async () => {
    const target = path.join(tmpDir, '.opencode');
    await fs.mkdir(target, { recursive: true });
    const packagePath = path.join(target, 'package.json');
    const customerPackage =
      '{\n    "name":"customer-owned",\n    "dependencies": { "@flowguard/core": "customer-pin", "zod":"^4.0.0" }\n}\n\n';
    await fs.writeFile(packagePath, customerPackage, 'utf-8');

    const result = await uninstall(repoArgs({ action: 'uninstall' }));

    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toContain('preserving package.json byte-for-byte');
    expect(await fs.readFile(packagePath, 'utf-8')).toBe(customerPackage);
    expect(result.ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: packagePath,
          action: 'skipped',
          reason: 'ownership not proven; no mutation performed',
        }),
      ]),
    );
  });
});
