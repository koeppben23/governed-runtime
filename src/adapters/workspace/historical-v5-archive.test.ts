/**
 * @module adapters/workspace/historical-v5-archive.test
 * @description Fixed archive bytes produced by the V5-capable commit
 * 33efb381, verified unchanged by the current archive authority. The fixture is
 * a real historical export, not a V6 archive transformed during the test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { archiveFileName } from './archive-layout.js';
import { verifyCompletionExport } from './archive-verify-chain.js';
import { sessionDir, workspacesHome } from './init.js';
import { hashFile } from '../../shared/hashing.js';
import { isBindableReviewTransport } from '../../state/evidence-review-invocation.js';
import { withTestEnv } from '../../integration/test-helpers.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-4466554400af';
const FINGERPRINT = '700575aea7fc40041c56a1d3';
const FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'historical-v5-export.tar.gz');
const SESSION_FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'historical-v5-session');

let restore: (() => void) | undefined;
let configDir: string | undefined;

afterEach(async () => {
  restore?.();
  restore = undefined;
  if (configDir !== undefined) await fs.rm(configDir, { recursive: true, force: true });
  configDir = undefined;
});

async function installFixture(): Promise<string> {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'historical-v5-verify-'));
  restore = withTestEnv({ OPENCODE_CONFIG_DIR: configDir });
  const archiveDir = path.join(workspacesHome(), FINGERPRINT, 'sessions', 'archive');
  await fs.mkdir(archiveDir, { recursive: true });
  const liveSessionDir = sessionDir(FINGERPRINT, SESSION_ID);
  await fs.mkdir(liveSessionDir, { recursive: true });
  await fs.copyFile(
    path.join(SESSION_FIXTURE, 'audit.jsonl'),
    path.join(liveSessionDir, 'audit.jsonl'),
  );
  await fs.copyFile(
    path.join(SESSION_FIXTURE, 'session-state.json'),
    path.join(liveSessionDir, 'session-state.json'),
  );
  const target = path.join(archiveDir, archiveFileName(SESSION_ID, 'export'));
  await fs.copyFile(FIXTURE, target);
  await fs.copyFile(`${FIXTURE}.sha256`, `${target}.sha256`);
  return target;
}

describe('historical V5 completion export', () => {
  it('verifies the fixed historical artifact and reports only an informational finding', async () => {
    await installFixture();
    const verification = await verifyCompletionExport(FINGERPRINT, SESSION_ID);
    expect(verification.passed).toBe(true);
    expect(verification.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'review_evidence_historical_transport',
          severity: 'info',
        }),
      ]),
    );
    expect(verification.findings.some((finding) => finding.severity === 'error')).toBe(false);
  });

  it('rejects tampering even when the sidecar is recomputed', async () => {
    const target = await installFixture();
    const bytes = await fs.readFile(target);
    await fs.writeFile(target, Buffer.concat([bytes, Buffer.from('tamper')]));
    await fs.writeFile(`${target}.sha256`, `${await hashFile(target)}  ${path.basename(target)}\n`);
    const verification = await verifyCompletionExport(FINGERPRINT, SESSION_ID);
    expect(verification.passed).toBe(false);
  });

  it('never treats the historical invocation as a bindable transport', async () => {
    await installFixture();
    const verification = await verifyCompletionExport(FINGERPRINT, SESSION_ID);
    expect(verification.passed).toBe(true);
    expect(
      isBindableReviewTransport({
        invocationMode: 'native_task_message_json',
        transportVersion: 5,
      }),
    ).toBe(false);
  });
});
