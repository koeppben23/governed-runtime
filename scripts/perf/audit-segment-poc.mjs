/**
 * Standalone proof of concept for the Phase-2 segmented audit journal.
 *
 * This script does NOT touch production code or a real session. It demonstrates
 * the three properties required before implementation:
 * - partial-tail crash recovery without accepting a partial event;
 * - detection of a modified closed segment;
 * - downgrade-compatible concatenation into canonical JSONL.
 *
 * The manifest/head is local. A privileged attacker can rewrite it; production
 * still needs an external anchor as specified in ADR-015.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SEGMENT_SIZE = 4;
const dir = await mkdtemp(join(tmpdir(), 'fg-audit-segment-poc-'));
const manifestPath = join(dir, 'manifest.json');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function event(index) {
  return JSON.stringify({
    id: randomUUID(),
    flowguardSessionId: '00000000-0000-4000-8000-000000000001',
    phase: 'IMPLEMENTATION',
    event: 'state_write',
    auditSequence: index + 1,
    detail: { index },
  });
}

function parseCompleteLines(content) {
  const lines = content.split('\n');
  const complete = lines.slice(0, -1);
  const tail = lines.at(-1) ?? '';
  for (const line of complete) JSON.parse(line);
  return { complete, tail };
}

async function writeManifest(segments, head) {
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 1, segments, head }, null, 2)}\n`,
    'utf8',
  );
}

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

async function verify() {
  const manifest = await readManifest();
  let previous = 'genesis';
  for (const segment of manifest.segments) {
    const content = await readFile(join(dir, segment.file), 'utf8');
    const expected = digest(`${previous}:${content}`);
    if (expected !== segment.digest) return { valid: false, reason: segment.file };
    previous = segment.digest;
  }
  return { valid: previous === manifest.head, reason: previous === manifest.head ? null : 'head' };
}

try {
  const total = 10;
  const segments = [];
  let active = '';
  let activeCount = 0;
  let previous = 'genesis';
  let fileIndex = 0;

  for (let index = 0; index < total; index++) {
    const line = event(index);
    active += `${line}\n`;
    activeCount++;
    if (activeCount === SEGMENT_SIZE || index === total - 1) {
      const file = `segment-${String(fileIndex).padStart(6, '0')}.jsonl`;
      await writeFile(join(dir, file), active, 'utf8');
      const segmentDigest = digest(`${previous}:${active}`);
      segments.push({ file, count: activeCount, digest: segmentDigest });
      previous = segmentDigest;
      active = '';
      activeCount = 0;
      fileIndex++;
    }
  }
  await writeManifest(segments, previous);
  const baseline = await verify();

  // Simulate a crash while appending a line to the active last segment.
  const last = segments.at(-1);
  const lastPath = join(dir, last.file);
  await writeFile(lastPath, `${await readFile(lastPath, 'utf8')}{"id":"partial`, 'utf8');
  const crashed = await readFile(lastPath, 'utf8');
  const { complete, tail } = parseCompleteLines(crashed);
  await truncate(lastPath, Buffer.byteLength(complete.join('\n') + '\n'));
  const recoveredContent = await readFile(lastPath, 'utf8');
  const recoveredSegmentDigest = digest(
    `${segments.at(-2)?.digest ?? 'genesis'}:${recoveredContent}`,
  );
  segments[segments.length - 1] = {
    ...last,
    count: complete.length,
    digest: recoveredSegmentDigest,
  };
  previous = recoveredSegmentDigest;
  await writeManifest(segments, previous);
  const recovered = await verify();

  // A closed segment modification must be detected.
  const probe = await readFile(lastPath, 'utf8');
  await writeFile(
    lastPath,
    probe.replace('"event":"state_write"', '"event":"state_tamper"'),
    'utf8',
  );
  const tampered = await verify();
  await writeFile(lastPath, probe, 'utf8');

  // Downgrade view: concatenating segments yields canonical JSONL.
  const ordered = (await readdir(dir))
    .filter((name) => name.startsWith('segment-') && name.endsWith('.jsonl'))
    .sort();
  const combined = (
    await Promise.all(ordered.map((name) => readFile(join(dir, name), 'utf8')))
  ).join('');
  const downgraded = combined
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  console.log(
    JSON.stringify({
      benchmark: 'audit-segment-poc',
      baseline,
      crashRecovery: {
        status: recovered.valid ? 'PASS' : 'FAIL',
        partialTailObserved: tail.length > 0,
        recoveredEvents: recoveredContent.split('\n').filter(Boolean).length,
      },
      tamperDetection: {
        status: tampered.valid ? 'FAIL' : 'PASS',
        reason: tampered.reason,
      },
      downgradeRead: {
        status: downgraded.length === total ? 'PASS' : 'FAIL',
        events: downgraded.length,
      },
      scope: 'local PoC; external anchor and production integration are NOT_VERIFIED',
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
