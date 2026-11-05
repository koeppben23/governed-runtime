/**
 * @module cli/iso27001-java-demo.test
 * @description Wrapper contract for the post-export Java demo ISO projection.
 *
 * The wrapper is intentionally thin: it resolves the installed FlowGuard CLI,
 * calls the existing inspect command twice, compares the semantic digests in
 * the JSON and Markdown companions, and publishes both after an atomic target
 * claim. These tests use a fake installed CLI at the real repo-install path so
 * the resolution and publication mechanics are deterministic; the product ISO
 * projection itself remains covered by the inspect-iso27001 suites.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WRAPPER = path.join(REPO_ROOT, 'demos', 'java-task-manager', 'run-iso-mapping.sh');
const MAPPING = path.join(REPO_ROOT, 'demos', 'java-task-manager', 'iso27001-demo-mapping.json');
const SESSION = 'ses_demo123';
const POSIX = process.platform !== 'win32';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);

const FAKE_CLI = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const mode = process.env.FAKE_MODE || 'success';
if (mode === 'exit1') process.exit(1);
if (mode === 'exit2') process.exit(2);
if (mode === 'nooutput') process.exit(0);
if (!output) process.exit(1);
const report = {
  reportSchemaVersion: 'iso27001-evidence-report.v1',
  evidencePackage: { verification: 'verified_snapshot', packageSha256: '${A}' },
  organization: { mappingDigest: '${B}' },
  soaVerification: 'not_verified',
  controls: [
    { controlRef: { controlId: 'A.8.15' }, status: 'EVIDENCE_LINKED_VERIFIED', rules: [{}] },
    { controlRef: { controlId: 'A.8.25' }, status: 'EVIDENCE_LINKED_VERIFIED', rules: [{}] },
    { controlRef: { controlId: 'A.8.29' }, status: 'EVIDENCE_MISSING', rules: [{}] },
    { controlRef: { controlId: 'A.8.32' }, status: 'EVIDENCE_LINKED_VERIFIED', rules: [{}] }
  ],
  reportDigest: '${C}',
  publisher: process.env.FAKE_PUBLISHER || null
};
const write = () => {
  if (args.includes('--json')) {
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  } else {
    const reportDigest = mode === 'mismatch' ? '${D}' : report.reportDigest;
    fs.writeFileSync(output, '# ISO report\n' + reportDigest + '\n' + report.organization.mappingDigest + '\n' + report.evidencePackage.packageSha256 + '\nPublisher: ' + report.publisher + '\n');
  }
};
const delay = Number(process.env.FAKE_DELAY_MS || 0);
if (delay > 0) setTimeout(write, delay); else write();
`;

interface Workspace {
  readonly root: string;
  readonly workspace: string;
  readonly outputRoot: string;
  readonly configDir: string;
}

async function createWorkspace(options: { installed?: boolean; globalInstalled?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fg-java-iso-wrapper-'));
  const workspace = path.join(root, 'workspace');
  const outputRoot = path.join(root, 'reports');
  const configDir = path.join(root, 'config');
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(workspace, 'pom.xml'), '<project/>\n', 'utf8');
  await copyFile(WRAPPER, path.join(workspace, 'run-iso-mapping.sh'));
  await copyFile(MAPPING, path.join(workspace, 'iso27001-demo-mapping.json'));
  await chmod(path.join(workspace, 'run-iso-mapping.sh'), 0o755);

  const installCli = async (base: string) => {
    const cliDir = path.join(base, 'node_modules', '@flowguard', 'core', 'dist', 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(base, 'node_modules', '@flowguard', 'core', 'package.json'),
      JSON.stringify({ name: '@flowguard/core', version: '2.0.0-tp.2-test' }),
      'utf8',
    );
    await writeFile(path.join(cliDir, 'install.js'), FAKE_CLI, 'utf8');
  };

  if (options.installed !== false) await installCli(path.join(workspace, '.opencode'));
  if (options.globalInstalled) await installCli(configDir);
  return { root, workspace, outputRoot, configDir } satisfies Workspace;
}

function wrapperEnv(workspace: Workspace, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    NODE: process.execPath,
    OPENCODE_CONFIG_DIR: workspace.configDir,
    ...extra,
  };
}

function runWrapper(workspace: Workspace, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [path.join(workspace.workspace, 'run-iso-mapping.sh'), ...args], {
    cwd: workspace.workspace,
    env: wrapperEnv(workspace, extraEnv),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

async function runWrapperAsync(
  workspace: Workspace,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bash', [path.join(workspace.workspace, 'run-iso-mapping.sh'), ...args], {
      cwd: workspace.workspace,
      env: wrapperEnv(workspace, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe.skipIf(!POSIX)('java demo ISO wrapper', () => {
  it('resolves the repo-scoped installed CLI and publishes actual control statuses', async () => {
    const workspace = await createWorkspace();
    try {
      const result = runWrapper(workspace, [
        '--session',
        SESSION,
        '--output-root',
        workspace.outputRoot,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Export:     verified_snapshot');
      expect(result.stdout).toContain('SoA:        not_verified');
      expect(result.stdout).toContain('A.8.29     EVIDENCE_MISSING');
      expect(result.stdout).toContain('Evidence-to-control mapping only.');
      expect(result.stdout).toContain('.opencode/node_modules/@flowguard/core/dist/cli/install.js');
      const jsonPath = path.join(workspace.outputRoot, SESSION, 'iso27001-report.json');
      const mdPath = path.join(workspace.outputRoot, SESSION, 'iso27001-report.md');
      expect(existsSync(jsonPath)).toBe(true);
      expect(existsSync(mdPath)).toBe(true);
      const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
        reportDigest: string;
        organization: { mappingDigest: string };
        evidencePackage: { packageSha256: string };
      };
      expect(json.reportDigest).toBe(C);
      expect(json.organization.mappingDigest).toBe(B);
      expect(json.evidencePackage.packageSha256).toBe(A);

      const second = runWrapper(workspace, [
        '--session',
        SESSION,
        '--output-root',
        workspace.outputRoot,
      ]);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('refusing to overwrite');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('resolves a global installed CLI from OPENCODE_CONFIG_DIR', async () => {
    const workspace = await createWorkspace({ installed: false, globalInstalled: true });
    try {
      const result = runWrapper(workspace, [
        '--session',
        SESSION,
        '--output-root',
        workspace.outputRoot,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(workspace.configDir);
      expect(result.stdout).toContain('@flowguard/core/dist/cli/install.js');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('gives FLOWGUARD_BIN priority over the installed path', async () => {
    const workspace = await createWorkspace();
    try {
      const explicit = path.join(workspace.root, 'explicit-flowguard.js');
      await writeFile(explicit, FAKE_CLI, 'utf8');
      const result = runWrapper(
        workspace,
        ['--session', SESSION, '--output-root', workspace.outputRoot],
        { FLOWGUARD_BIN: explicit },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(explicit);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['exit1', 1],
    ['exit2', 2],
    ['nooutput', 1],
    ['mismatch', 1],
  ] as const)('propagates %s without publishing a final report', async (mode, expected) => {
    const workspace = await createWorkspace();
    try {
      const result = runWrapper(
        workspace,
        ['--session', SESSION, '--output-root', workspace.outputRoot],
        { FAKE_MODE: mode },
      );
      expect(result.status).toBe(expected);
      expect(existsSync(path.join(workspace.outputRoot, SESSION))).toBe(false);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('rejects an output root inside the workspace before writing', async () => {
    const workspace = await createWorkspace();
    try {
      const inside = path.join(workspace.workspace, 'reports');
      const result = runWrapper(workspace, ['--session', SESSION, '--output-root', inside]);
      expect(result.status).toBe(1);
      expect(existsSync(inside)).toBe(false);
      expect(result.stderr).toContain('outside the git worktree');
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('rejects output-root symlinks into the worktree or config directory', async () => {
    const workspace = await createWorkspace();
    try {
      for (const target of [workspace.workspace, workspace.configDir]) {
        const link = path.join(
          workspace.root,
          target === workspace.workspace ? 'workspace-link' : 'config-link',
        );
        await symlink(target, link, 'dir');
        const result = runWrapper(workspace, ['--session', SESSION, '--output-root', link]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('outside the');
        expect(existsSync(path.join(target, SESSION))).toBe(false);
      }
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('requires an explicit safe session id', async () => {
    const workspace = await createWorkspace();
    try {
      const missing = runWrapper(workspace, ['--output-root', workspace.outputRoot]);
      expect(missing.status).toBe(1);
      const unsafe = runWrapper(workspace, [
        '--session',
        '../ses_demo123',
        '--output-root',
        workspace.outputRoot,
      ]);
      expect(unsafe.status).toBe(1);
      expect(existsSync(path.join(workspace.outputRoot, SESSION))).toBe(false);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('allows only one of two concurrent publications for the same session', async () => {
    const workspace = await createWorkspace();
    try {
      const [first, second] = await Promise.all([
        runWrapperAsync(workspace, ['--session', SESSION, '--output-root', workspace.outputRoot], {
          FAKE_DELAY_MS: '250',
        }),
        runWrapperAsync(workspace, ['--session', SESSION, '--output-root', workspace.outputRoot], {
          FAKE_DELAY_MS: '250',
        }),
      ]);
      expect(
        [first.status, second.status].sort(),
        JSON.stringify({
          platform: process.platform,
          outputRoot: workspace.outputRoot,
          first,
          second,
        }),
      ).toEqual([0, 1]);
      const dir = path.join(workspace.outputRoot, SESSION);
      expect(existsSync(path.join(dir, 'iso27001-report.json'))).toBe(true);
      expect(existsSync(path.join(dir, 'iso27001-report.md'))).toBe(true);
      const files = await Promise.all([
        readFile(path.join(dir, 'iso27001-report.json'), 'utf8'),
        readFile(path.join(dir, 'iso27001-report.md'), 'utf8'),
      ]);
      expect(files[0]).toContain(C);
      expect(files[1]).toContain(C);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it('fails closed and cleans staging when the Node reservation is denied', async () => {
    const workspace = await createWorkspace();
    try {
      const preload = path.join(workspace.root, 'deny-claim.cjs');
      await writeFile(
        preload,
        `
const fs = require('node:fs');
const original = fs.mkdirSync;
fs.mkdirSync = function(target) {
  if (target === process.env.CLAIM_TARGET) {
    const error = new Error('reservation denied by test');
    error.code = 'EACCES';
    throw error;
  }
  return original.apply(this, arguments);
};
`,
      );
      const result = runWrapper(
        workspace,
        ['--session', SESSION, '--output-root', workspace.outputRoot],
        {
          CLAIM_TARGET: path.join(await realpath(workspace.root), 'reports', SESSION),
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(preload)}`]
            .filter(Boolean)
            .join(' '),
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('EACCES');
      expect(result.stderr).toContain('cannot reserve report directory');
      expect(await readdir(workspace.outputRoot)).toEqual([]);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'traces exclusive Node claims with a broken external mkdir: %s',
    async (brokenMkdir) => {
      const workspace = await createWorkspace();
      try {
        const final = path.join(await realpath(workspace.root), 'reports', SESSION);
        const bin = path.join(workspace.root, 'bin');
        const barrier = path.join(workspace.root, 'barrier');
        const trace = path.join(workspace.root, 'mkdir-claims.jsonl');
        const externalClaim = path.join(workspace.root, 'external-claim');
        await mkdir(bin);
        await mkdir(barrier);
        // Shell mkdir is still used for staging/output setup, never final ownership.
        const nativeMkdir = ['/bin/mkdir', '/usr/bin/mkdir'].find((candidate) =>
          existsSync(candidate),
        );
        expect(nativeMkdir, 'a native POSIX mkdir binary must exist').toBeDefined();
        if (!nativeMkdir) throw new Error('native mkdir is unavailable');
        const tracer = path.join(workspace.root, 'trace-mkdir.cjs');
        // Test-only scheduling: call the original Node filesystem primitive after
        // both publishers arrive. No production hook, retry or lock substitute.
        await writeFile(
          tracer,
          String.raw`
const fs = require('node:fs');
const path = require('node:path');
const nativeMkdir = fs.mkdirSync;
fs.mkdirSync = function(target, options) {
  if (target !== process.env.CLAIM_TARGET) return nativeMkdir.apply(this, arguments);
  fs.writeFileSync(path.join(process.env.CLAIM_BARRIER, process.env.FAKE_PUBLISHER), 'ready');
  const deadline = Date.now() + 4000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!['publisher-a', 'publisher-b'].every(p => fs.existsSync(path.join(process.env.CLAIM_BARRIER, p)))) {
    if (Date.now() >= deadline) { process.stderr.write('claim rendezvous expired'); process.exit(99); }
    Atomics.wait(wait, 0, 0, 5);
  }
  const existedBefore = fs.existsSync(target);
  let errorCode = null;
  try {
    return nativeMkdir.apply(this, arguments);
  } catch (error) {
    errorCode = error.code;
    throw error;
  } finally {
    fs.appendFileSync(process.env.CLAIM_TRACE, JSON.stringify({
      publisher: process.env.FAKE_PUBLISHER, target,
      realParent: fs.realpathSync(path.dirname(target)),
      primitive: 'node:fs.mkdirSync', recursive: options?.recursive === true,
      existedBefore, status: errorCode === null ? 0 : 1, errorCode,
      inode: fs.existsSync(target) ? fs.statSync(target).ino : null,
    }) + '\n');
  }
};
`,
          'utf8',
        );
        await writeFile(
          path.join(bin, 'mkdir'),
          brokenMkdir
            ? `#!/usr/bin/env bash
if [ "$#" -eq 1 ] && [ "$1" = "$CLAIM_TARGET" ]; then
  printf 'used\\n' >> "$EXTERNAL_CLAIM"
  exec "$NODE" -e 'require("node:fs").mkdirSync(process.argv[1], {recursive:true})' "$1"
fi
exec "$NATIVE_MKDIR" "$@"
`
            : '#!/usr/bin/env bash\nexec "$NATIVE_MKDIR" "$@"\n',
        );
        await chmod(path.join(bin, 'mkdir'), 0o755);
        const publishers = ['publisher-a', 'publisher-b'];
        const results = await Promise.all(
          publishers.map((publisher) =>
            runWrapperAsync(
              workspace,
              ['--session', SESSION, '--output-root', workspace.outputRoot],
              {
                PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
                FAKE_PUBLISHER: publisher,
                NATIVE_MKDIR: nativeMkdir,
                CLAIM_TARGET: final,
                CLAIM_BARRIER: barrier,
                CLAIM_TRACE: trace,
                EXTERNAL_CLAIM: externalClaim,
                NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(tracer)}`]
                  .filter(Boolean)
                  .join(' '),
              },
            ),
          ),
        );
        const observations = JSON.stringify({ final, publishers, results });
        expect(existsSync(trace), observations).toBe(true);
        const claims = (await readFile(trace, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)) as {
          publisher: string;
          target: string;
          realParent: string;
          primitive: string;
          recursive: boolean;
          existedBefore: boolean;
          status: number;
          errorCode: string | null;
          inode: number;
        }[];
        const diagnostic = JSON.stringify({ final, publishers, results, claims });
        expect(results.map((result) => result.status).sort(), diagnostic).toEqual([0, 1]);
        expect(claims.map((claim) => claim.status).sort(), diagnostic).toEqual([0, 1]);
        expect(claims).toHaveLength(2);
        expect(claims.map((claim) => claim.primitive)).toEqual([
          'node:fs.mkdirSync',
          'node:fs.mkdirSync',
        ]);
        expect(claims.every((claim) => !claim.recursive)).toBe(true);
        expect(claims.find((claim) => claim.status === 1)!.errorCode).toBe('EEXIST');
        expect(existsSync(externalClaim), diagnostic).toBe(false);
        expect(new Set(claims.map((claim) => claim.target))).toEqual(new Set([final]));
        expect(new Set(claims.map((claim) => claim.realParent)).size).toBe(1);
        expect(new Set(claims.map((claim) => claim.inode))).toEqual(
          new Set([(await stat(final)).ino]),
        );
        const winner = claims.find((claim) => claim.status === 0)!.publisher;
        expect(publishers[results.findIndex((result) => result.status === 0)]).toBe(winner);
        const json = JSON.parse(await readFile(path.join(final, 'iso27001-report.json'), 'utf8'));
        expect(json.publisher, diagnostic).toBe(winner);
        expect(await readFile(path.join(final, 'iso27001-report.md'), 'utf8')).toContain(
          `Publisher: ${winner}\n`,
        );
        expect(results.find((result) => result.status === 1)!.stderr).toContain(
          'refusing to overwrite',
        );
        expect(await readdir(workspace.outputRoot)).toEqual([SESSION]);
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    },
  );
});
