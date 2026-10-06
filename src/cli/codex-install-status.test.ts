/**
 * @module cli/codex-install-status.test
 * @description Classification tests for codexInstallStatus (C1): registered,
 * not activated, unreadable, and malformed marketplaces are distinguishable.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  codexInstallStatus,
  resolveCodexMarketplacePath,
  resolveCodexPluginRoot,
} from './codex-plugin-install.js';

const REGISTERED_ENTRY = {
  name: 'flowguard',
  source: { source: 'local', path: './plugins/flowguard' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Productivity',
};

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-codex-status-'));
  originalCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmp, { recursive: true, force: true });
});

async function seedPluginTree(): Promise<void> {
  const pluginManifest = path.join(resolveCodexPluginRoot('repo'), '.codex-plugin', 'plugin.json');
  await fs.mkdir(path.dirname(pluginManifest), { recursive: true });
  await fs.writeFile(pluginManifest, '{"name":"flowguard"}', 'utf-8');
}

async function writeMarketplace(content: string): Promise<void> {
  const marketplacePath = resolveCodexMarketplacePath('repo');
  await fs.mkdir(path.dirname(marketplacePath), { recursive: true });
  await fs.writeFile(marketplacePath, content, 'utf-8');
}

describe('codexInstallStatus', () => {
  it('reports INSTALLED_AND_REGISTERED for a matching FlowGuard entry', async () => {
    await seedPluginTree();
    await writeMarketplace(JSON.stringify({ plugins: [REGISTERED_ENTRY] }));

    expect(codexInstallStatus('repo')).toBe('INSTALLED_AND_REGISTERED');
  });

  it('reports INSTALLED_NOT_ACTIVATED when the plugin manifest is missing', async () => {
    await writeMarketplace(JSON.stringify({ plugins: [REGISTERED_ENTRY] }));

    expect(codexInstallStatus('repo')).toBe('INSTALLED_NOT_ACTIVATED');
  });

  it('reports INSTALLED_NOT_ACTIVATED when the FlowGuard entry is absent', async () => {
    await seedPluginTree();
    await writeMarketplace(JSON.stringify({ plugins: [{ name: 'other' }] }));

    expect(codexInstallStatus('repo')).toBe('INSTALLED_NOT_ACTIVATED');
  });

  it('reports INSTALLED_NOT_ACTIVATED when the entry path does not match', async () => {
    await seedPluginTree();
    await writeMarketplace(
      JSON.stringify({
        plugins: [{ ...REGISTERED_ENTRY, source: { source: 'local', path: './elsewhere' } }],
      }),
    );

    expect(codexInstallStatus('repo')).toBe('INSTALLED_NOT_ACTIVATED');
  });

  it('reports MARKETPLACE_MALFORMED for invalid JSON', async () => {
    await seedPluginTree();
    await writeMarketplace('{not json');

    expect(codexInstallStatus('repo')).toBe('MARKETPLACE_MALFORMED');
  });

  it('reports MARKETPLACE_MALFORMED for a non-object top level', async () => {
    await seedPluginTree();
    await writeMarketplace('[]');

    expect(codexInstallStatus('repo')).toBe('MARKETPLACE_MALFORMED');
  });

  it('reports MARKETPLACE_MALFORMED when plugins is not an array', async () => {
    await seedPluginTree();
    await writeMarketplace(JSON.stringify({ plugins: { name: 'flowguard' } }));

    expect(codexInstallStatus('repo')).toBe('MARKETPLACE_MALFORMED');
  });

  it('reports MARKETPLACE_MALFORMED when the FlowGuard entry lacks its shape', async () => {
    await seedPluginTree();
    await writeMarketplace(JSON.stringify({ plugins: [{ name: 'flowguard' }] }));

    expect(codexInstallStatus('repo')).toBe('MARKETPLACE_MALFORMED');
  });

  it('reports MARKETPLACE_UNREADABLE when the marketplace cannot be read', async () => {
    await seedPluginTree();
    const marketplacePath = resolveCodexMarketplacePath('repo');
    await fs.mkdir(marketplacePath, { recursive: true });

    expect(codexInstallStatus('repo')).toBe('MARKETPLACE_UNREADABLE');
  });
});
