/**
 * @module cli/doctor-executables.test
 * @description Tests for #423 — doctor validates the shipped `dist/` executable
 * surface derived from the package.json `bin` SSOT, fail-closed.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkShippedExecutables } from './doctor-command.js';
import { SHIPPED_EXECUTABLE_CHECK } from './install-helpers.js';

const SHEBANG = '#!/usr/bin/env node';

describe('checkShippedExecutables (#423)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fg-doctor-bin-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePackageJson(bin: unknown): void {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pkg', bin }), 'utf-8');
  }

  function writeExecutable(relPath: string, content = `${SHEBANG}\nconsole.log(1);\n`): void {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('reports ok for every present, shebang-prefixed executable', () => {
    writePackageJson({
      flowguard: './dist/cli/install.js',
      'flowguard-mcp': './dist/mcp-server/index.js',
    });
    writeExecutable('dist/cli/install.js');
    writeExecutable('dist/mcp-server/index.js');

    const checks = checkShippedExecutables(root);

    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(checks.every((c) => c.check === SHIPPED_EXECUTABLE_CHECK)).toBe(true);
  });

  it('reports missing when a shipped executable does not exist (negative path)', () => {
    writePackageJson({ flowguard: './dist/cli/install.js' });
    // intentionally do NOT create the file

    const checks = checkShippedExecutables(root);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('missing');
    expect(checks[0]?.check).toBe(SHIPPED_EXECUTABLE_CHECK);
    expect(checks[0]?.file).toBe(join(root, './dist/cli/install.js'));
  });

  it('reports error when a shipped executable is empty (corruption)', () => {
    writePackageJson({ flowguard: './dist/cli/install.js' });
    writeExecutable('dist/cli/install.js', '');

    const checks = checkShippedExecutables(root);

    expect(checks[0]?.status).toBe('error');
    expect(checks[0]?.detail).toContain('empty');
  });

  it('reports error when a shipped executable lacks the Node shebang (corruption)', () => {
    writePackageJson({ flowguard: './dist/cli/install.js' });
    writeExecutable('dist/cli/install.js', 'console.log("no shebang");\n');

    const checks = checkShippedExecutables(root);

    expect(checks[0]?.status).toBe('error');
    expect(checks[0]?.detail).toContain('shebang');
  });

  it('reports error when the bin target is a directory, not a regular file', () => {
    writePackageJson({ flowguard: './dist/cli/install.js' });
    mkdirSync(join(root, 'dist/cli/install.js'), { recursive: true });

    const checks = checkShippedExecutables(root);

    expect(checks[0]?.status).toBe('error');
    expect(checks[0]?.detail).toContain('regular file');
  });

  it('automatically validates a newly added bin entry (proves SSOT derivation)', () => {
    writePackageJson({
      flowguard: './dist/cli/install.js',
      'flowguard-future': './dist/cli/future.js',
    });
    writeExecutable('dist/cli/install.js');
    // new bin entry has no corresponding file → must be detected without code change

    const checks = checkShippedExecutables(root);

    expect(checks).toHaveLength(2);
    const future = checks.find((c) => c.file.endsWith('future.js'));
    expect(future?.status).toBe('missing');
  });

  describe('fail-closed manifest handling', () => {
    function expectSingleManifestError(): void {
      const checks = checkShippedExecutables(root);
      expect(checks).toHaveLength(1);
      expect(checks[0]?.status).toBe('error');
      expect(checks[0]?.check).toBe(SHIPPED_EXECUTABLE_CHECK);
      expect(checks[0]?.detail).toContain('bin map');
    }

    it('fails closed when package.json is absent', () => {
      // no package.json written
      expectSingleManifestError();
    });

    it('fails closed when package.json is unparseable', () => {
      writeFileSync(join(root, 'package.json'), '{ not json', 'utf-8');
      expectSingleManifestError();
    });

    it('fails closed when bin field is missing', () => {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pkg' }), 'utf-8');
      expectSingleManifestError();
    });

    it('fails closed when bin is an empty object', () => {
      writePackageJson({});
      expectSingleManifestError();
    });

    it('fails closed when bin is an array', () => {
      writePackageJson(['./dist/cli/install.js']);
      expectSingleManifestError();
    });

    it('fails closed when bin is a string', () => {
      writePackageJson('./dist/cli/install.js');
      expectSingleManifestError();
    });

    it('fails closed when bin contains a non-string target', () => {
      writePackageJson({ flowguard: './dist/cli/install.js', broken: 123 });
      expectSingleManifestError();
    });
  });
});
