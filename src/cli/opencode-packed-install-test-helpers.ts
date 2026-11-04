/** Real packed CLI/install bytes for native-host tests; never seeds governance. */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBuffer } from '../shared/hashing.js';

export async function createPackedFlowGuardInstall() {
  const root = await mkdtemp(join(tmpdir(), 'fg-packed-parity-'));
  try {
    let tarball: string;
    if (process.env.FLOWGUARD_TARBALL) {
      const supplied = resolve(process.env.FLOWGUARD_TARBALL);
      tarball = join(root, basename(supplied));
      await copyFile(supplied, tarball);
      await copyFile(join(dirname(supplied), 'checksums.sha256'), join(root, 'checksums.sha256'));
    } else {
      const packed = JSON.parse(
        execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          encoding: 'utf8',
          timeout: 60_000,
        }),
      ) as Array<{ filename: string }>;
      if (!packed[0]) throw new Error('npm pack returned no artifact');
      tarball = join(root, packed[0].filename);
      await writeFile(
        join(root, 'checksums.sha256'),
        `${hashBuffer(await readFile(tarball))}  ${basename(tarball)}\n`,
      );
    }
    const bootstrap = join(root, 'bootstrap');
    execFileSync(
      'npm',
      ['install', '--prefix', bootstrap, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      { cwd: root, encoding: 'utf8', timeout: 300_000 },
    );
    const packedRoot = join(bootstrap, 'node_modules/@flowguard/core');
    const identity = {
      file: basename(tarball),
      sha256: hashBuffer(await readFile(tarball)),
      build: JSON.parse(
        await readFile(join(packedRoot, 'dist/build-info.json'), 'utf8'),
      ) as unknown,
    };
    console.info('inactive-parity-artifact', JSON.stringify(identity));
    return {
      identity,
      async install(project: string, env: NodeJS.ProcessEnv, scope: 'repo' | 'global' = 'repo') {
        const output = execFileSync(
          process.execPath,
          [
            join(packedRoot, 'dist/cli/install.js'),
            'install',
            '--install-scope',
            scope,
            '--core-tarball',
            tarball,
          ],
          {
            cwd: project,
            env: { ...env, FLOWGUARD_INSTALL_LOCK_PATH: join(project, '.install.lock') },
            encoding: 'utf8',
            timeout: 300_000,
          },
        );
        const target = scope === 'repo' ? join(project, '.opencode') : env.OPENCODE_CONFIG_DIR;
        if (!target) throw new Error('No isolated OpenCode install target');
        const installed = join(target, 'node_modules/@flowguard/core');
        if (
          (await readFile(join(installed, 'dist/integration/plugin.js'), 'utf8')) !==
          (await readFile(join(packedRoot, 'dist/integration/plugin.js'), 'utf8'))
        )
          throw new Error('Installed plugin differs from the packed bootstrap bytes');
        return output;
      },
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
