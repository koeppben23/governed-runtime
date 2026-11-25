/** Shared `npx` probe for coverage runner tests; no production behavior. */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const probeSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = (prefix) => {
  const match = args.find((arg) => arg.startsWith(prefix));
  return match === undefined ? undefined : match.slice(prefix.length);
};
if (process.env.PROBE_LOG) {
  fs.appendFileSync(
    process.env.PROBE_LOG,
    JSON.stringify({ args, perf: process.env.FLOWGUARD_PERF }) + '\n',
  );
}
if (args.includes('list')) {
  process.stdout.write(process.env.PROBE_INVENTORY || '[]');
  process.exit(Number(process.env.PROBE_LIST_EXIT || 0));
}
if (args.some((arg) => arg.startsWith('--merge-reports='))) {
  const exit = Number(process.env.PROBE_MERGE_EXIT || 0);
  if (exit === 0 && process.env.PROBE_WRITE_SUMMARY === '1') {
    const directory = process.env.PROBE_REPORT_DIR;
    const file = process.env.PROBE_REPO_ROOT + '/src/example.ts';
    const metric = { total: 1, covered: 1, skipped: 0, pct: 100 };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'coverage-summary.json'),
      JSON.stringify({
        total: {
          branches: metric,
          functions: metric,
          lines: metric,
          statements: metric,
          branchesTrue: { total: 0, covered: 0, skipped: 0, pct: 100 },
        },
        [file]: {
          branches: metric,
          functions: metric,
          lines: metric,
          statements: metric,
          branchesTrue: { total: 0, covered: 0, skipped: 0, pct: 100 },
        },
      }) + '\n',
    );
  }
  process.exit(exit);
}
const exit = Number(process.env.PROBE_RUN_EXIT || 0);
if (exit !== 0) process.exit(exit);
if (process.env.PROBE_SHARD_SUCCESS === '1') {
  const repo = process.env.PROBE_REPO_ROOT;
  const blob = path.resolve(repo, value('--outputFile.blob=') || 'vitest.blob.json');
  const results = path.resolve(repo, value('--outputFile.json=') || 'vitest-results.json');
  const files = JSON.parse(process.env.PROBE_FILES || '[]');
  fs.mkdirSync(path.dirname(blob), { recursive: true });
  fs.mkdirSync(path.dirname(results), { recursive: true });
  fs.writeFileSync(blob, 'probe-blob');
  fs.writeFileSync(
    results,
    JSON.stringify({
      success: true,
      numTotalTests: files.length,
      testResults: files.map((file) => ({ name: path.resolve(repo, file) })),
    }),
  );
}
process.exit(0);
`;

/** Install a fake `npx` into `binDir` and return the directory. */
export function installNpxProbe(binDir: string): string {
  const probe = join(binDir, 'npx-probe.cjs');
  writeFileSync(probe, probeSource);
  const command = join(binDir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@"${process.execPath}" "${probe}" %*\r\n`
      : `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(probe).href)});\n`,
  );
  chmodSync(command, 0o755);
  return command;
}
