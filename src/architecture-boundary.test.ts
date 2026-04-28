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

describe('Architecture Boundary Smoke', () => {
  it('has core source layer directories', () => {
    assertDirectoryExists('state');
    assertDirectoryExists('machine');
    assertDirectoryExists('rails');
    assertDirectoryExists('adapters');
    assertDirectoryExists('integration');
  });
});
