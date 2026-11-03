/** Native setup/cleanup, real registration smoke and exact API baseline integrity.
 * Package declarations are not installed Desktop/CLI certification. */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from '@opencode/plugin';
import { FlowGuardAuditPlugin, isUsableWorktree } from './plugin.js';
import { createV2Host, v2ToolEvent } from './opencode-v2-test-helpers.js';
import { makeState } from '../fixtures.js';
import {
  PLATFORMS,
  normalize,
  readConfiguredSource,
  readNativeVersions,
  sha256,
} from '../../scripts/sdk-type-snapshot.mjs';

const disposers: Plugin.Cleanup[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
async function setup(directory: string, active = false) {
  const host = createV2Host(directory);
  if (active) await host.seedActive('session', makeState('TICKET').policySnapshot.hash);
  const dispose = await FlowGuardAuditPlugin.setup(host.ctx);
  expect(typeof dispose).toBe('function');
  if (dispose) disposers.push(dispose);
  return host;
}

describe('native V2 plugin definition resilience', () => {
  it.each(['/nonexistent/path', '', '/'])(
    'registers lazily at %j and owns every cleanup',
    async (directory) => {
      const host = await setup(directory);
      expect([...host.toolHooks.keys()]).toEqual(['execute.before', 'execute.after']);
      expect([...host.sessionHooks.keys()]).toEqual([
        'prompt',
        'context',
        'compaction',
        'generate',
        'model.request',
      ]);
      expect(host.sessionGet).not.toHaveBeenCalled();
      // The only native command is /start; it never records workflow decision intent.
      expect(host.context.command.transform).toHaveBeenCalledOnce();
      expect([...host.commands.keys()]).toEqual(['start']);
      await disposers.at(-1)!();
      expect(host.registrations.every((r) => r.dispose.mock.calls.length === 1)).toBe(true);
    },
  );

  it.each(['', undefined, '/', 'C:\\', 'D:/'])('rejects unusable worktree %j', (directory) => {
    expect(isUsableWorktree(directory)).toBe(false);
  });

  it('accepts an existing non-root directory as usable, not as Git or governance proof', () => {
    expect(isUsableWorktree(process.cwd())).toBe(true);
  });

  it('does not query absent V1 context fields', async () => {
    const host = createV2Host('/nonexistent/path');
    for (const key of [
      'client',
      'project',
      '$',
      'serverUrl',
      'experimental_workspace',
      'worktree',
    ]) {
      Object.defineProperty(host.ctx, key, {
        get() {
          throw new Error(`Removed field read: ${key}`);
        },
      });
    }
    const dispose = await FlowGuardAuditPlugin.setup(host.ctx);
    if (dispose) disposers.push(dispose);
    expect(host.context.tool.hook).toHaveBeenCalledTimes(2);
  });

  it.each(['unknown_tool', ''])(
    'fails closed for %j before effect with no worktree authority',
    async (tool) => {
      const host = await setup('/nonexistent/path', true);
      await expect(host.before(v2ToolEvent({ tool, input: {} }))).rejects.toHaveProperty('code');
    },
  );

  it('does not create authority merely to observe an unmatched read-only completion', async () => {
    const host = await setup('/nonexistent/path');
    await host.after({ ...v2ToolEvent(), status: 'completed', result: { content: 'native' } });
    expect(host.sessionGet).toHaveBeenCalledOnce();
  });

  it('does not swallow authoritative after-hook location failures', async () => {
    const host = await setup('/nonexistent/path', true);
    await expect(
      host.after({
        ...v2ToolEvent({ tool: 'flowguard_status', input: {} }),
        status: 'completed',
        result: { content: '{}' },
      }),
    ).rejects.toHaveProperty('code');
  });
});

describe('native V2 SDK baseline infrastructure', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const config = PLATFORMS.opencode;
  const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

  it('checks every active baseline byte contract without a latest-SDK bypass', () => {
    for (const file of config.files) {
      expect(normalize(readFileSync(file.baseline, 'utf8')), file.label).toBe(
        normalize(readConfiguredSource(file)),
      );
    }
  });

  it('records exact plugin/client versions and hashes, independently of host support', () => {
    const metadata = json(config.versionFile);
    const packages = readNativeVersions(config);
    expect(metadata.platform).toBe('opencode');
    expect(metadata.packages).toEqual(packages);
    const pkg = json(path.join(root, 'package.json'));
    for (const [name, version] of Object.entries(packages))
      expect(pkg.devDependencies[name] ?? pkg.dependencies[name]).toBe(version);
    expect(metadata.files).toEqual(
      config.files.map((file) => ({
        label: file.label,
        hash: sha256(normalize(readConfiguredSource(file))),
      })),
    );
    expect(metadata).not.toHaveProperty('hostVersion');
    expect(metadata).not.toHaveProperty('installedSupport');
  });

  it('rejects missing or malformed package metadata rather than publishing unknown versions', () => {
    expect(() =>
      readNativeVersions({ versionSources: ['/nonexistent/native-package.json'] }),
    ).toThrow();
    expect(() => readNativeVersions({ versionSources: [path.join(root, 'package.json')] })).toThrow(
      'Invalid native package metadata',
    );
  });
});
