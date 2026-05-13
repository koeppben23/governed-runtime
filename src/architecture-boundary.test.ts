/**
 * @module architecture-boundary.test
 * @description Lightweight architecture boundary smoke checks.
 *
 * Authoritative layer-dependency enforcement lives in
 * `src/architecture/__tests__/dependency-rules.test.ts`.
 * This file intentionally stays minimal to avoid duplicated rule logic.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.resolve(import.meta.dirname, '.');

function assertDirectoryExists(relativeDir: string): void {
  const dir = path.join(SRC_DIR, relativeDir);
  expect(fs.existsSync(dir), `Expected directory '${relativeDir}' to exist`).toBe(true);
}

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf-8');
}

describe('Architecture Boundary Smoke', () => {
  it('has core source layer directories', () => {
    assertDirectoryExists('state');
    assertDirectoryExists('machine');
    assertDirectoryExists('rails');
    assertDirectoryExists('adapters');
    assertDirectoryExists('integration');
  });

  it('keeps CLI install facade split from command authorities', () => {
    const facade = readSource('cli/install.ts');

    expect(fs.existsSync(path.join(SRC_DIR, 'cli/install-command.ts'))).toBe(true);
    expect(fs.existsSync(path.join(SRC_DIR, 'cli/uninstall-command.ts'))).toBe(true);
    expect(fs.existsSync(path.join(SRC_DIR, 'cli/doctor-command.ts'))).toBe(true);

    expect(facade).toContain("from './install-command.js'");
    expect(facade).toContain("from './uninstall-command.js'");
    expect(facade).toContain("from './doctor-command.js'");
    expect(facade).not.toContain('export async function install(');
    expect(facade).not.toContain('export async function uninstall(');
    expect(facade).not.toContain('export async function doctor(');
  });
});
