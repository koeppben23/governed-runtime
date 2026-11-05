/** Real checksum-bound package through the demo setup; no host/model/activation claim. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashBuffer } from '../shared/hashing.js';

const REPO = resolve('.');
const SETUP = join(REPO, 'demos/java-task-manager/run-main-demo-setup.sh');
const LIB = join(REPO, 'demos/java-task-manager/install-flowguard-lib.sh');

describe.skipIf(process.platform === 'win32')('packed Java demo V2 installation', () => {
  it('prepares repo/global installs without V1 files and rejects broken native artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fg-demo-v2-install-'));
    try {
      const artifacts = join(root, 'artifacts');
      await mkdir(artifacts);
      let tarball: string;
      if (process.env.FLOWGUARD_TARBALL) {
        tarball = join(artifacts, basename(process.env.FLOWGUARD_TARBALL));
        await copyFile(process.env.FLOWGUARD_TARBALL, tarball);
        await copyFile(
          join(dirname(process.env.FLOWGUARD_TARBALL), 'checksums.sha256'),
          join(artifacts, 'checksums.sha256'),
        );
      } else {
        const packed = JSON.parse(
          execFileSync(
            'npm',
            ['pack', '--json', '--ignore-scripts', '--pack-destination', artifacts],
            { cwd: REPO, encoding: 'utf8', timeout: 60_000 },
          ),
        ) as { filename: string }[];
        tarball = join(artifacts, packed[0]!.filename);
        await writeFile(
          join(artifacts, 'checksums.sha256'),
          `${hashBuffer(await readFile(tarball))}  ${basename(tarball)}\n`,
        );
      }
      console.info(
        'java-demo-install-artifact',
        JSON.stringify({
          file: basename(tarball),
          sha256: hashBuffer(await readFile(tarball)),
          node: process.version,
        }),
      );
      const env = {
        ...process.env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        OPENCODE_CONFIG_DIR: join(root, 'config'),
        XDG_CONFIG_HOME: join(root, 'xdg-config'),
        XDG_DATA_HOME: join(root, 'xdg-data'),
        XDG_CACHE_HOME: join(root, 'xdg-cache'),
        XDG_STATE_HOME: join(root, 'xdg-state'),
        npm_config_yes: 'true',
        FLOWGUARD_INSTALL_LOCK_PATH: join(root, 'install.lock'),
      };
      await mkdir(env.HOME);
      for (const scope of ['repo', 'global'] as const) {
        const workspace = join(root, `workspace-${scope}`);
        const setup = spawnSync(
          'bash',
          [SETUP, '--install', '--install-scope', scope, '--tarball', tarball, workspace],
          { cwd: REPO, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
        );
        expect(setup.status, `${setup.stdout}\n${setup.stderr}`).toBe(0);
        expect(setup.stdout).toContain('FlowGuard install verified');
        const target = scope === 'repo' ? join(workspace, '.opencode') : env.OPENCODE_CONFIG_DIR;
        expect(existsSync(join(target, 'plugins/flowguard/index.ts'))).toBe(true);
        expect(existsSync(join(target, 'plugins/flowguard-audit.ts'))).toBe(false);
        expect(existsSync(join(target, 'tools/flowguard.ts'))).toBe(false);
        expect(existsSync(join(workspace, 'opencode.json'))).toBe(false);
        expect(existsSync(join(target, 'opencode.json'))).toBe(false);
        const verify = () =>
          spawnSync(
            'bash',
            ['-c', 'source "$1"; flowguard_verify_install "$2" "$3"', 'bash', LIB, tarball, scope],
            { cwd: workspace, env, encoding: 'utf8', timeout: 30_000 },
          );
        for (const file of [
          'plugins/flowguard/index.ts',
          'flowguard-mandates.md',
          'agents/flowguard-reviewer.md',
          'flowguard.json',
          'commands/plan.md',
        ]) {
          const original = join(target, file);
          await rename(original, `${original}.held`);
          try {
            const failure = verify();
            expect(
              failure.status,
              `missing ${scope}/${file}: ${failure.stdout}\n${failure.stderr}`,
            ).toBe(1);
            expect(failure.stderr).toContain('Do not start the demo');
          } finally {
            await rename(`${original}.held`, original);
          }
        }
        const plugin = join(target, 'plugins/flowguard/index.ts');
        const original = await readFile(plugin, 'utf8');
        await writeFile(plugin, 'export default {};\n');
        expect(verify().status).toBe(1);
        await writeFile(plugin, original);
        // A duplicate config registration is invalid even if the files exist.
        const config = join(scope === 'repo' ? workspace : target, 'opencode.json');
        await writeFile(config, '{"plugins":["@flowguard/core/integration/plugin"]}\n');
        expect(verify().status).toBe(1);
        await rm(config);
        expect(verify().status).toBe(0);
        console.info(
          'java-demo-install-verified',
          JSON.stringify({
            scope,
            build: JSON.parse(
              await readFile(
                join(target, 'node_modules/@flowguard/core/dist/build-info.json'),
                'utf8',
              ),
            ),
            workspace,
          }),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
