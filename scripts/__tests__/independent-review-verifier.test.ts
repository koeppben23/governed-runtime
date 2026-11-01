/** Verifier plumbing only. Synthetic reports test rejection, never native reviewer provenance. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const verifier = resolve('scripts/verify-independent-review-e2e.js');
const source = readFileSync(verifier, 'utf8');
const required = [
  ...source
    .split('const mustPassTestTitles = [')[1]!
    .split('];')[0]!
    .matchAll(/^  '(.+)',$/gm),
].map((match) => match[1]!);

function run(assertions: Array<{ title: string; status: string }>, exit = 0, raw?: string) {
  const root = mkdtempSync(join(tmpdir(), 'fg-review-verifier-'));
  try {
    mkdirSync(join(root, 'dist/cli'), { recursive: true });
    writeFileSync(
      join(root, 'dist/cli/install.js'),
      '// Build prerequisite fixture, never executed.\n',
    );
    const script = join(root, 'probe.cjs');
    writeFileSync(
      script,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--project') && args.includes('integration') && args.includes('smoke') && args.includes('--passWithNoTests=false') && process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1' && args.includes('src/cli/opencode-reviewer-capture-live.smoke.test.ts') && args.includes('src/cli/opencode-native-install.smoke.test.ts')) {
  const target = args.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
  fs.writeFileSync(target, process.env.PROBE_REPORT);
  process.exit(Number(process.env.PROBE_EXIT));
}
process.exit(99);\n`,
    );
    const command = join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx');
    writeFileSync(
      command,
      process.platform === 'win32'
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(script).href)});\n`,
    );
    chmodSync(command, 0o755);
    return spawnSync(process.execPath, [verifier], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH}`,
        PROBE_EXIT: String(exit),
        PROBE_REPORT: raw ?? JSON.stringify({ testResults: [{ assertionResults: assertions }] }),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const passed = () => required.map((title) => ({ title, status: 'passed' }));

describe('independent-review verifier gates', () => {
  it('retains both mandatory positives and requires actual native smoke + installed lifecycle projects', () => {
    expect(required).toEqual(
      expect.arrayContaining([
        'leaves the review-required output pending and authorizes the native Task before release',
        'records bound same-child evidence and fulfills the obligation',
        'loads exactly one installed definition, reloads it, and unloads after uninstall without rewriting customer config',
      ]),
    );
    expect(required.length).toBeGreaterThanOrEqual(9);
    const result = run(passed());
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(['pending', 'skipped', 'failed', 'todo'])(
    'rejects a mandatory positive reported as %s',
    (status) => {
      const assertions = passed();
      assertions[0]!.status = status;
      expect(run(assertions).status).toBe(1);
    },
  );
  it('rejects a missing mandatory positive', () => {
    expect(run(passed().slice(1)).status).toBe(1);
  });
  it('rejects duplicate title ambiguity, even if one occurrence passes', () => {
    expect(run([...passed(), { title: required[0]!, status: 'pending' }]).status).toBe(1);
  });
  it('preserves the runner failure even if a report claims success', () => {
    expect(run(passed(), 17).status).toBe(17);
  });
  it('rejects an unreadable report', () => {
    expect(run([], 0, '{invalid').status).toBe(1);
  });
});
