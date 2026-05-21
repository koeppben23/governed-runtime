/**
 * @module cli/run-hosts
 * @description Host binary mapping and executable resolution for flowguard run/serve.
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { platform } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import type { HostId } from '../shared/hosts.js';

export const HOST_SERVE_UNSUPPORTED = 'HOST_SERVE_UNSUPPORTED';

export interface HostCommandSpec {
  binary: string;
  buildRunArgs(prompt: string): string[];
  supportsServe: boolean;
  buildServeArgs?(config: { port: number; hostname: string }): string[];
}

export const HOST_COMMANDS: Record<HostId, HostCommandSpec> = {
  opencode: {
    binary: 'opencode',
    buildRunArgs: (prompt) => ['run', prompt],
    supportsServe: true,
    buildServeArgs: ({ port, hostname }) => ['serve', '--port', String(port), '--hostname', hostname],
  },
  'claude-code': {
    binary: 'claude',
    buildRunArgs: (prompt) => ['-p', prompt, '--output-format', 'stream-json'],
    supportsServe: false,
  },
  codex: {
    binary: 'codex',
    buildRunArgs: (prompt) => ['--non-interactive', '--prompt', prompt],
    supportsServe: false,
  },
};

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidates(binary: string): string[] {
  if (platform() !== 'win32') return [binary];
  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';');
  return extensions.map((ext) =>
    binary.toLowerCase().endsWith(ext.toLowerCase()) ? binary : `${binary}${ext}`,
  );
}

export async function resolveHostBinary(
  binary: string,
  env?: Record<string, string>,
): Promise<string | null> {
  if (binary.includes('/') || binary.includes('\\') || binary.includes(sep)) {
    return (await canExecute(binary)) ? binary : null;
  }

  const pathValue = env?.PATH ?? process.env.PATH ?? '';
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const candidate of executableCandidates(binary)) {
      const fullPath = join(directory, candidate);
      if (await canExecute(fullPath)) return fullPath;
    }
  }

  return null;
}
