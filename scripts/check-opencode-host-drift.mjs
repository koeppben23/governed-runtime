#!/usr/bin/env node
/** Exact native CLI candidate comparison, never product/Desktop certification. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidatePath = path.join(root, '.sdk-baselines/opencode/cli-candidate.json');

class HostDriftError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Check the whole reported version; suffixes and surrounding text are not accepted. */
export function checkHostVersion(candidate, reported) {
  if (
    candidate?.package !== '@opencode/cli' ||
    candidate.status !== 'candidate' ||
    typeof candidate.version !== 'string' ||
    !/^2\.\d+\.\d+$/.test(candidate.version)
  ) {
    throw new HostDriftError(
      'OPENCODE_CANDIDATE_INVALID',
      'Invalid native V2 CLI candidate metadata.',
    );
  }
  const expected = `opencode v${candidate.version}`;
  if (typeof reported !== 'string' || reported.trim() !== expected) {
    throw new HostDriftError(
      'OPENCODE_HOST_VERSION_MISMATCH',
      `Expected exactly ${expected}; received ${String(reported)}. Use ${candidate.package}@${candidate.version} for candidate tests. API updates do not accept host drift.`,
    );
  }
  return `Native CLI candidate matches: ${expected}. This is not ACTIVE product or Desktop certification.`;
}

export function run(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    console.error(
      'OPENCODE_HOST_ARGUMENT_INVALID: no arguments accepted; this check does not update or certify hosts.',
    );
    return 1;
  }
  try {
    const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    // Validate metadata before invoking any host executable.
    checkHostVersion(candidate, `opencode v${candidate?.version}`);
    const command = process.env.OPENCODE_CLI || 'opencode';
    const probe = spawnSync(command, ['--version'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (probe.status !== 0) {
      throw new HostDriftError(
        'OPENCODE_HOST_PROBE_FAILED',
        `${command} --version failed: ${probe.error?.message ?? probe.stderr ?? probe.status}`,
      );
    }
    console.log(checkHostVersion(candidate, probe.stdout));
    return 0;
  } catch (error) {
    console.error(`${error.code ?? 'OPENCODE_HOST_CHECK_FAILED'}: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
