/**
 * @module demos/lib/host-config
 * @description Isolated OpenCode host configuration for the live demo runners.
 *
 * The host truncates any tool output above `tool_output.max_bytes` (default
 * 50 KiB / 51200 bytes in the tested OpenCode 1.19.0) and replaces it with a
 * marker; the demo transcript trust guard then rejects the governed output,
 * turning an otherwise valid run into NOT_VERIFIED. The worst observed
 * `flowguard_status` payload is 51,475 bytes, so the runners raise the budget
 * in their isolated `OPENCODE_CONFIG_DIR`. Only `tool_output.max_bytes` is
 * set — every other resolved setting keeps the host default — and any
 * pre-existing configuration in the file is preserved, never silently
 * overwritten.
 *
 * @version v1
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Tested host tool-output budget for the live runners: at least 2x the worst
 * observed `flowguard_status` payload (51,475 bytes), while still keeping host
 * truncation as the fail-closed backstop for runaway outputs.
 */
export const HOST_TOOL_OUTPUT_MAX_BYTES = 131072;

/** File name the host loader reads from `OPENCODE_CONFIG_DIR`. */
export const HOST_CONFIG_FILE = 'opencode.json';

/**
 * Write the isolated host config into `configDir`. Creates the file when
 * absent; when present, every existing key is preserved and only
 * `tool_output.max_bytes` is enforced. A conflicting pre-existing
 * `tool_output.max_bytes` fails loudly instead of being overridden.
 */
export function writeIsolatedHostConfig(configDir) {
  const file = path.join(configDir, HOST_CONFIG_FILE);
  let existing = {};
  if (fs.existsSync(file)) {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    const configured = existing?.tool_output?.max_bytes;
    if (configured !== undefined && configured !== HOST_TOOL_OUTPUT_MAX_BYTES) {
      throw new Error(
        `isolated host config already sets tool_output.max_bytes=${String(configured)}; ` +
          'refusing to override it',
      );
    }
  }
  const preserved = Object.fromEntries(
    Object.entries(existing).filter(([key]) => key !== 'tool_output'),
  );
  const config = {
    ...preserved,
    tool_output: { ...(existing.tool_output ?? {}), max_bytes: HOST_TOOL_OUTPUT_MAX_BYTES },
  };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}
