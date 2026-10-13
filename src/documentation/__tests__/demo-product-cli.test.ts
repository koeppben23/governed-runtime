/**
 * @module documentation/demo-product-cli.test
 * @description The bound product CLI must be installed into an isolated npm
 * prefix together with its declared dependencies and executed from there;
 * merely extracting the tarball is not sufficient.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 * @version v1
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installTarball, productCli } from '../../../demos/lib/product-cli.mjs';

const roots: string[] = [];

function fixtureRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `flowguard-product-cli-${label}-`));
  roots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A dependency-bearing product fixture packed as a real npm tarball. */
function packFixtureProduct(root: string): string {
  const depDir = join(root, 'fixture-dep');
  mkdirSync(depDir, { recursive: true });
  writeJson(join(depDir, 'package.json'), {
    name: 'fixture-dep',
    version: '1.0.0',
    main: 'index.js',
  });
  writeFileSync(join(depDir, 'index.js'), "module.exports = { marker: 'dep-resolved' };\n");

  const productDir = join(root, 'fixture-product');
  mkdirSync(join(productDir, 'dist'), { recursive: true });
  writeJson(join(productDir, 'package.json'), {
    name: 'fixture-product',
    version: '1.0.0',
    dependencies: { 'fixture-dep': `file:${depDir}` },
  });
  writeFileSync(
    join(productDir, 'dist', 'cli.js'),
    "const { marker } = require('fixture-dep');\n" +
      "require('node:fs').writeFileSync(process.argv[2], marker);\n",
  );
  const packDir = join(root, 'pack');
  mkdirSync(packDir, { recursive: true });
  const packed = execFileSync('npm', ['pack', '--pack-destination', packDir, productDir], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1);
  if (!packed) throw new Error('npm pack produced no tarball');
  return join(packDir, packed);
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('product CLI isolated installation', () => {
  describe('HAPPY — installed with dependencies and executable', () => {
    it('installs the tarball into an isolated prefix and runs its CLI with resolved deps', () => {
      const root = fixtureRoot('happy');
      const tarball = packFixtureProduct(root);
      const cli = productCli({
        tarball,
        root,
        packageName: 'fixture-product',
        relativeCli: 'dist/cli.js',
      });
      expect(cli).toContain(join('.tooling', 'product-prefix', 'node_modules', 'fixture-product'));
      expect(existsSync(join(root, '.tooling', 'product-prefix', 'node_modules'))).toBe(true);
      const marker = join(root, 'marker.txt');
      execFileSync(process.execPath, [cli, marker]);
      expect(readFileSync(marker, 'utf8')).toBe('dep-resolved');
    });
  });

  describe('BAD — missing artifacts fail closed', () => {
    it('rejects a tarball without the expected CLI', () => {
      const root = fixtureRoot('bad');
      const tarball = packFixtureProduct(root);
      expect(() =>
        productCli({
          tarball,
          root,
          packageName: 'fixture-product',
          relativeCli: 'dist/missing.js',
        }),
      ).toThrow(/CLI missing/);
    });
  });

  describe('CORNER — installation is idempotent per root', () => {
    it('reuses an existing isolated prefix', () => {
      const root = fixtureRoot('corner');
      const tarball = packFixtureProduct(root);
      const prefix = join(root, '.tooling', 'product-prefix');
      installTarball({ tarball, prefix });
      const again = installTarball({
        tarball: join(root, 'does-not-exist.tgz'),
        prefix,
      });
      expect(again).toBe(prefix);
    });
  });

  describe('EDGE — the extracted-tarball failure mode is covered', () => {
    it('produces node_modules for the installed package (not just extracted files)', () => {
      const root = fixtureRoot('edge');
      const tarball = packFixtureProduct(root);
      const prefix = installTarball({ tarball, prefix: join(root, '.tooling', 'product-prefix') });
      expect(existsSync(join(prefix, 'node_modules', 'fixture-dep'))).toBe(true);
      expect(existsSync(join(prefix, 'node_modules', 'fixture-product', 'dist', 'cli.js'))).toBe(
        true,
      );
    });
  });
});
