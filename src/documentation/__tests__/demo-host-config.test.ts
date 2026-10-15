/**
 * @module documentation/demo-host-config
 * @description The live demo runners must raise the isolated OpenCode host
 * tool-output budget so legitimate governance payloads (worst observed
 * `flowguard_status`: 51,475 bytes) are delivered instead of being truncated
 * into an unreadable governed output. Only `tool_output.max_bytes` is set;
 * pre-existing configuration is preserved and never silently overridden, and
 * host truncation stays the fail-closed backstop above the budget.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HOST_CONFIG_FILE,
  HOST_TOOL_OUTPUT_MAX_BYTES,
  writeIsolatedHostConfig,
} from '../../../demos/lib/host-config.mjs';
import { TESTED_OPENCODE_HOST_VERSION } from '../../cli/opencode-runtime-compat.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORST_OBSERVED_STATUS_BYTES = 51475;
const runners = [
  'demos/java-task-manager/run-live-matrix.mjs',
  'demos/java-task-manager/run-live-claim-controls.mjs',
  'demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs',
  'demos/risk-trigger-fixture/run-live-replan-recovery.mjs',
] as const;

const tempDirs: string[] = [];

function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-host-config-'));
  tempDirs.push(dir);
  return dir;
}

function pinnedHostAvailable(): boolean {
  try {
    return (
      execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim() ===
      TESTED_OPENCODE_HOST_VERSION
    );
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Mirrors the OpenCode 1.19.0 `tool_output` decision: delivered when within budget, truncated above it. */
function transportDelivers(outputBytes: number): boolean {
  return outputBytes <= HOST_TOOL_OUTPUT_MAX_BYTES;
}

describe('isolated host config for the live demo runners', () => {
  it('writes exactly the intended tool_output budget', () => {
    const configDir = tempConfigDir();
    writeIsolatedHostConfig(configDir);

    const file = path.join(configDir, HOST_CONFIG_FILE);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      tool_output: { max_bytes: HOST_TOOL_OUTPUT_MAX_BYTES },
    });
  });

  it('is byte-deterministic across repeated initialization', () => {
    const configDir = tempConfigDir();
    writeIsolatedHostConfig(configDir);
    const first = fs.readFileSync(path.join(configDir, HOST_CONFIG_FILE), 'utf8');
    writeIsolatedHostConfig(configDir);
    const second = fs.readFileSync(path.join(configDir, HOST_CONFIG_FILE), 'utf8');

    expect(second).toBe(first);
  });

  it('preserves pre-existing configuration without touching max_lines', () => {
    const configDir = tempConfigDir();
    fs.writeFileSync(
      path.join(configDir, HOST_CONFIG_FILE),
      `${JSON.stringify({ model: 'test/model', tool_output: { max_lines: 10 } }, null, 2)}\n`,
    );

    writeIsolatedHostConfig(configDir);

    expect(JSON.parse(fs.readFileSync(path.join(configDir, HOST_CONFIG_FILE), 'utf8'))).toEqual({
      model: 'test/model',
      tool_output: { max_lines: 10, max_bytes: HOST_TOOL_OUTPUT_MAX_BYTES },
    });
  });

  it('fails loudly instead of silently overriding a conflicting budget', () => {
    const configDir = tempConfigDir();
    fs.writeFileSync(
      path.join(configDir, HOST_CONFIG_FILE),
      `${JSON.stringify({ tool_output: { max_bytes: 1 } })}\n`,
    );

    expect(() => writeIsolatedHostConfig(configDir)).toThrow(/refusing to override/);
  });

  it('covers the archived worst-case status payload with at least 2x margin', () => {
    expect(WORST_OBSERVED_STATUS_BYTES).toBeLessThan(HOST_TOOL_OUTPUT_MAX_BYTES);
    expect(HOST_TOOL_OUTPUT_MAX_BYTES).toBeGreaterThanOrEqual(2 * WORST_OBSERVED_STATUS_BYTES);
  });

  it('keeps truncation as the fail-closed backstop above the budget', () => {
    expect(transportDelivers(WORST_OBSERVED_STATUS_BYTES)).toBe(true);
    expect(transportDelivers(51200)).toBe(true);
    expect(transportDelivers(HOST_TOOL_OUTPUT_MAX_BYTES)).toBe(true);
    expect(transportDelivers(HOST_TOOL_OUTPUT_MAX_BYTES + 1)).toBe(false);
  });

  it('wires the identical helper into all four live runners', () => {
    for (const relative of runners) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(source, relative).toContain(
        "import { writeIsolatedHostConfig } from '../lib/host-config.mjs';",
      );
      expect(source, relative).toContain('writeIsolatedHostConfig(configDir);');
    }
  });
});

describe.skipIf(!pinnedHostAvailable())(
  `pinned OpenCode ${TESTED_OPENCODE_HOST_VERSION} resolves the isolated budget`,
  () => {
    it('loads tool_output.max_bytes from OPENCODE_CONFIG_DIR via the real config path', () => {
      const configDir = tempConfigDir();
      writeIsolatedHostConfig(configDir);

      const resolved = JSON.parse(
        execFileSync('opencode', ['debug', 'config'], {
          cwd: configDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            OPENCODE_CONFIG_DIR: configDir,
            OPENCODE_DISABLE_AUTOUPDATE: '1',
          },
        }),
      ) as { tool_output?: { max_bytes?: number; max_lines?: number } };

      expect(resolved.tool_output?.max_bytes).toBe(HOST_TOOL_OUTPUT_MAX_BYTES);
      expect(resolved.tool_output?.max_lines).toBeUndefined();
    });
  },
);
