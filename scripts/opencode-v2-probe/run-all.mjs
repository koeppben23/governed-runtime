#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const evidence = join(root, 'scripts/opencode-v2-probe/evidence');
await mkdir(evidence, { recursive: true });
const skipBackup = process.argv.includes('--skip-backup');

const steps = [
  ...(skipBackup ? [] : [['backup', 'scripts/opencode-v2-probe/backup-restore.mjs']]),
  ['desktop-backend', 'scripts/opencode-v2-probe/probes/desktop-backend.mjs'],
  ['plugin-activation', 'scripts/opencode-v2-probe/probes/plugin-activation.mjs'],
  ['tool-discovery', 'scripts/opencode-v2-probe/probes/tool-discovery.mjs'],
  ['fences', 'scripts/opencode-v2-probe/probes/fences.mjs'],
  ['command-provenance', 'scripts/opencode-v2-probe/probes/command-provenance.mjs'],
  ['reviewer-lineage', 'scripts/opencode-v2-probe/probes/reviewer-lineage.mjs'],
  ['subagent-contract', 'scripts/opencode-v2-probe/probes/subagent-contract.mjs'],
  ['model-wire', 'scripts/opencode-v2-probe/probes/model-wire.mjs'],
  ['length-steps', 'scripts/opencode-v2-probe/probes/length-steps.mjs'],
  ['mandate-source', 'scripts/opencode-v2-probe/probes/mandate-source.mjs'],
  ['provider-executed', 'scripts/opencode-v2-probe/probes/provider-executed.mjs'],
];

const summary = {
  at: new Date().toISOString(),
  opencode: spawnSync('opencode', ['--version'], { encoding: 'utf8' }).stdout?.trim(),
  steps: [],
};
for (const [name, script] of steps) {
  console.log(`\n=== ${name} ===`);
  const outDir = join(evidence, name);
  await mkdir(outDir, { recursive: true });
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, FG_PROBE_OUT: outDir },
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  let report;
  try {
    report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8'));
  } catch {
    report = undefined;
  }
  summary.steps.push({
    name,
    script,
    exitCode: result.status,
    signal: result.signal,
    reportPath: report ? join(outDir, 'report.json') : null,
    passed: report?.passed ?? null,
    status: report?.status ?? null,
  });
}
await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log('\n' + JSON.stringify(summary, null, 2));
// The probe is evidence collection, but a non-zero step must not look like a
// clean run. Expected NOT_VERIFIED probes are still real failures for GO.
if (summary.steps.some((step) => step.exitCode !== 0)) process.exitCode = 1;
