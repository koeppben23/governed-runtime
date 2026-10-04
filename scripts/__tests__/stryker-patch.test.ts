import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'stryker-patch.js');
const temporaryDirectories: string[] = [];

const POOL_SOURCE = [
  "const legacy = { pool: 'threads' };",
  "const current = { pool: 'threads' };",
].join('\n');
const TEST_HELPERS_SOURCE = "const nameParts = [];\nreturn nameParts.join(' ').trim();\n";
const STRYKER_SETUP_SOURCE = "const nameParts = [];\nreturn nameParts.join(' ').trim();\n";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeFixtureFile(root: string, relativePath: string, content: string) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return target;
}

function createFixture({
  runnerVersion = '10.0.0',
  vitestVersion = '5.0.0',
  testHelpersSource = TEST_HELPERS_SOURCE,
}: {
  runnerVersion?: string;
  vitestVersion?: string;
  testHelpersSource?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowguard-stryker-patch-'));
  temporaryDirectories.push(root);

  writeFixtureFile(root, 'package.json', '{"type":"module"}\n');
  const fixtureScript = writeFixtureFile(root, 'scripts/.gitkeep', '');
  copyFileSync(scriptPath, join(dirname(fixtureScript), 'stryker-patch.js'));
  writeFixtureFile(
    root,
    'node_modules/@stryker-mutator/vitest-runner/package.json',
    JSON.stringify({ version: runnerVersion }),
  );
  writeFixtureFile(
    root,
    'node_modules/vitest/package.json',
    JSON.stringify({ version: vitestVersion }),
  );

  return {
    root,
    runner: writeFixtureFile(
      root,
      'node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js',
      POOL_SOURCE,
    ),
    testHelpers: writeFixtureFile(
      root,
      'node_modules/@stryker-mutator/vitest-runner/dist/src/test-helpers.js',
      testHelpersSource,
    ),
    strykerSetup: writeFixtureFile(
      root,
      'node_modules/@stryker-mutator/vitest-runner/dist/src/stryker-setup.js',
      STRYKER_SETUP_SOURCE,
    ),
  };
}

function runPatch(root: string) {
  return spawnSync(process.execPath, ['scripts/stryker-patch.js'], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('stryker-patch', () => {
  it('patches and then recognizes the Stryker 10/Vitest 5 artifacts', () => {
    const fixture = createFixture();

    const firstRun = runPatch(fixture.root);

    expect(firstRun.status).toBe(0);
    expect(firstRun.stdout).toContain('Patched Vitest pool configuration');
    expect(firstRun.stdout).toContain('Patched Vitest 5 test name separator');
    expect(readFileSync(fixture.runner, 'utf8')).not.toContain("pool: 'threads'");
    expect(readFileSync(fixture.testHelpers, 'utf8')).toContain("nameParts.join(' > ')");
    expect(readFileSync(fixture.strykerSetup, 'utf8')).toContain("nameParts.join(' > ')");

    const secondRun = runPatch(fixture.root);

    expect(secondRun.status).toBe(0);
    expect(secondRun.stdout).toContain('Vitest pool configuration already patched');
    expect(secondRun.stdout).toContain('Vitest 5 test name separator already patched');
  });

  it('leaves the test-name separator unchanged for Vitest 4', () => {
    const fixture = createFixture({ vitestVersion: '4.1.11' });

    const result = runPatch(fixture.root);

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.runner, 'utf8')).not.toContain("pool: 'threads'");
    expect(readFileSync(fixture.testHelpers, 'utf8')).toContain("nameParts.join(' ')");
    expect(readFileSync(fixture.strykerSetup, 'utf8')).toContain("nameParts.join(' ')");
    expect(result.stdout).toContain('does not require the name separator patch');
  });

  it('rejects an unsupported Vitest major before modifying artifacts', () => {
    const fixture = createFixture({ vitestVersion: '6.0.0' });

    const result = runPatch(fixture.root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('vitest@6.0.0 is unsupported');
    expect(readFileSync(fixture.runner, 'utf8')).toContain("pool: 'threads'");
    expect(readFileSync(fixture.testHelpers, 'utf8')).toContain("nameParts.join(' ')");
  });

  it('rejects an unsupported runner before modifying artifacts', () => {
    const fixture = createFixture({ runnerVersion: '10.0.1' });

    const result = runPatch(fixture.root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@stryker-mutator/vitest-runner@10.0.1 is unsupported');
    expect(readFileSync(fixture.runner, 'utf8')).toContain("pool: 'threads'");
    expect(readFileSync(fixture.testHelpers, 'utf8')).toContain("nameParts.join(' ')");
  });

  it('rejects an unexpected artifact shape before modifying other artifacts', () => {
    const fixture = createFixture({ testHelpersSource: 'const nameParts = [];\n' });

    const result = runPatch(fixture.root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Vitest 5 test name separator');
    expect(readFileSync(fixture.runner, 'utf8')).toContain("pool: 'threads'");
    expect(readFileSync(fixture.strykerSetup, 'utf8')).toContain("nameParts.join(' ')");
  });
});
