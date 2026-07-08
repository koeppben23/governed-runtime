/**
 * @module cli/doctor-executables
 * @description Shipped executable surface validation for the doctor command.
 *
 * Extracted from doctor-command.ts to keep the module under the 700 LOC
 * threshold. The executable manifest (package.json `bin`) is the SSOT.
 *
 * @version v1
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePackageRoot, SHIPPED_EXECUTABLE_CHECK } from './install-helpers.js';
import type { DoctorCheck } from './install-types.js';

/** Node shebang every shipped FlowGuard executable must begin with. */
const EXPECTED_EXECUTABLE_SHEBANG = '#!/usr/bin/env node';

function readShippedExecutableManifest(packageRoot: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
  const bin = (parsed as { bin?: unknown } | null)?.bin;
  if (typeof bin !== 'object' || bin === null || Array.isArray(bin)) return null;
  const entries = Object.entries(bin);
  if (entries.length === 0) return null;
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    return null;
  }
  return Object.fromEntries(entries);
}

function validateShippedExecutable(file: string): DoctorCheck {
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return {
        file,
        status: 'missing',
        detail: 'shipped executable not found',
        check: SHIPPED_EXECUTABLE_CHECK,
      };
    }
    if (code === 'EISDIR') {
      return {
        file,
        status: 'error',
        detail: 'shipped executable is not a regular file',
        check: SHIPPED_EXECUTABLE_CHECK,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      file,
      status: 'error',
      detail: `cannot read shipped executable: ${msg}`,
      check: SHIPPED_EXECUTABLE_CHECK,
    };
  }
  if (content.length === 0) {
    return {
      file,
      status: 'error',
      detail: 'shipped executable is empty',
      check: SHIPPED_EXECUTABLE_CHECK,
    };
  }
  const firstLine = content.split('\n', 1)[0] ?? '';
  if (firstLine !== EXPECTED_EXECUTABLE_SHEBANG) {
    return {
      file,
      status: 'error',
      detail: 'shipped executable missing Node shebang (corrupt)',
      check: SHIPPED_EXECUTABLE_CHECK,
    };
  }
  return { file, status: 'ok', check: SHIPPED_EXECUTABLE_CHECK };
}

export function checkShippedExecutables(packageRoot: string = resolvePackageRoot()): DoctorCheck[] {
  const manifest = readShippedExecutableManifest(packageRoot);
  if (manifest === null) {
    return [
      {
        file: join(packageRoot, 'package.json'),
        status: 'error',
        detail:
          'package.json bin map missing, empty, or not an object — cannot validate shipped executables',
        check: SHIPPED_EXECUTABLE_CHECK,
      },
    ];
  }
  return Object.values(manifest).map((relativeTarget) =>
    validateShippedExecutable(join(packageRoot, relativeTarget)),
  );
}
