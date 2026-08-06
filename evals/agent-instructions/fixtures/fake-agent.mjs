#!/usr/bin/env node

/**
 * fake-agent.mjs
 *
 * Deterministic fake CLI for testing the eval runner without a real
 * agent host. Supports multiple modes via first CLI argument.
 *
 * Usage: node fake-agent.mjs <mode>
 *
 * Modes:
 *   pass             — exit 0, benign stdout
 *   crash            — exit 137
 *   timeout          — hang indefinitely
 *   signal           — process.exit with signal-like code
 *   exit-1           — exit 1, stderr message
 *   not_verified     — output NOT_VERIFIED marker
 *   blocked          — output BLOCKED marker
 *   workspace-write  — write a file to the workspace
 *   workspace-delete — delete a file from the workspace
 *   large-output     — produce > 10 KB of output
 *   echo-stdin       — echo stdin to stdout
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'pass';
const cwd = process.cwd();

async function main() {
  switch (mode) {
    case 'timeout':
      // Hang long enough that the runner's timeout fires first.
      // Using a long setTimeout rather than an unresolved Promise
      // so that the event loop runs but the process doesn't exit.
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      process.exit(0);

    case 'crash':
      process.exit(137);

    case 'signal':
      process.kill(process.pid, 'SIGTERM');

    case 'exit-1':
      process.stderr.write('error: something went wrong\n');
      process.exit(1);

    case 'not_verified':
      process.stdout.write('Change applied. Architecture test not run.\n');
      process.stderr.write('NOT_VERIFIED: npm run test:architecture unavailable\n');
      process.exit(0);

    case 'blocked':
      process.stdout.write('BLOCKED: cannot proceed without git write access\n');
      process.exit(0);

    case 'workspace-write':
      writeFileSync(join(cwd, 'new-file.txt'), 'created by fake agent\n');
      process.stdout.write('File created.\n');
      process.exit(0);

    case 'workspace-delete':
      try {
        unlinkSync(join(cwd, 'removable.txt'));
        process.stdout.write('Deleted.\n');
      } catch {
        process.stderr.write('File not found.\n');
      }
      process.exit(0);

    case 'large-output':
      for (let i = 0; i < 500; i++) {
        process.stdout.write(`Line ${i}: ${'x'.repeat(80)}\n`);
      }
      process.exit(0);

    case 'echo-stdin': {
      const rl = createInterface({ input: process.stdin });
      process.stdout.write('Received stdin:\n');
      for await (const line of rl) {
        process.stdout.write(line + '\n');
      }
      process.exit(0);
    }

    default:
      process.stdout.write('All checks passed.\n');
      process.exit(0);
  }
}

main().catch(() => process.exit(1));
