/** Native notification replay exercises the real canonical audit lock and writer. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeState } from '../fixtures.js';
import * as persistence from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import { appendSessionErrorAuditOnce } from './plugin-session-error-audit.js';

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'fg-session-error-audit-'));
  return {
    sessDir: directory,
    governedSessionId: 'root',
    nativeSessionId: 'root',
    state: makeState('PLAN'),
    errorMessage: 'native failure',
    detail: {
      eventType: 'session.execution.failed',
      errorType: 'unknown',
      supplementary: { hostEventId: 'failure-1', hostCreatedAt: 100 },
    },
  };
}

describe('durable native session-error auditing', () => {
  it('commits once across concurrent delivery, module reload and a later phase', async () => {
    const input = await fixture();
    await Promise.all(Array.from({ length: 4 }, () => appendSessionErrorAuditOnce(input)));
    const first = await readAuditTrail(input.sessDir);
    expect(first).toHaveLength(1);
    expect(first[0]!.detail).not.toHaveProperty('nativeSessionId');
    expect(first[0]).toMatchObject({
      phase: 'PLAN',
      hostSessionId: 'root',
      flowguardSessionId: input.state.flowguardSessionId,
      occurredAt: new Date(100).toISOString(),
      event: 'error:SESSION_ERROR',
      actor: 'machine',
      detail: { code: 'SESSION_ERROR', message: 'native failure', ...input.detail },
    });
    vi.resetModules();
    const reloaded = await import('./plugin-session-error-audit.js');
    await reloaded.appendSessionErrorAuditOnce({
      ...input,
      state: { ...input.state, phase: 'VALIDATION' },
    });
    expect(await readAuditTrail(input.sessDir)).toEqual(first);
    expect(verifyChain(first).valid).toBe(true);
  });
  it('keeps independent event identities even with identical diagnostics', async () => {
    const input = await fixture();
    await appendSessionErrorAuditOnce(input);
    await appendSessionErrorAuditOnce({
      ...input,
      detail: {
        ...input.detail,
        supplementary: { ...input.detail.supplementary, hostEventId: 'failure-2' },
      },
    });
    const events = await readAuditTrail(input.sessDir);
    expect(events).toHaveLength(2);
    expect(events[0]!.id).not.toBe(events[1]!.id);
    expect(verifyChain(events).valid).toBe(true);
  });
  it("uses each independent error's own first phase, not another error's phase", async () => {
    const input = await fixture();
    await appendSessionErrorAuditOnce(input);
    const second = {
      ...input,
      state: { ...input.state, phase: 'VALIDATION' as const },
      detail: {
        ...input.detail,
        supplementary: { ...input.detail.supplementary, hostEventId: 'failure-2' },
      },
    };
    await appendSessionErrorAuditOnce(second);
    await appendSessionErrorAuditOnce({
      ...second,
      state: { ...input.state, phase: 'IMPLEMENTATION' },
    });
    expect((await readAuditTrail(input.sessDir)).map((event) => event.phase)).toEqual([
      'PLAN',
      'VALIDATION',
    ]);
  });
  it('preserves the failed child identity without changing the governed audit owner', async () => {
    const input = await fixture();
    await appendSessionErrorAuditOnce({ ...input, nativeSessionId: 'child' });
    expect((await readAuditTrail(input.sessDir))[0]).toMatchObject({
      hostSessionId: 'root',
      detail: { nativeSessionId: 'child' },
    });
  });
  it.each(['message', 'time', 'type', 'child', 'owner'] as const)(
    'rejects the same native event identity with changed %s',
    async (change) => {
      const input = await fixture();
      await appendSessionErrorAuditOnce(input);
      const changed = {
        ...input,
        detail: { ...input.detail, supplementary: { ...input.detail.supplementary } },
      };
      if (change === 'message') changed.errorMessage = 'different';
      if (change === 'time') changed.detail.supplementary.hostCreatedAt++;
      if (change === 'type') changed.detail.errorType = 'provider';
      if (change === 'child') changed.nativeSessionId = 'child';
      if (change === 'owner') changed.governedSessionId = 'other-root';
      await expect(appendSessionErrorAuditOnce(changed)).rejects.toMatchObject({
        code: 'SCHEMA_VALIDATION_FAILED',
      });
      expect(await readAuditTrail(input.sessDir)).toHaveLength(1);
    },
  );
  it.each([
    undefined,
    null,
    [],
    {},
    { hostEventId: '', hostCreatedAt: 100 },
    { hostEventId: 1, hostCreatedAt: 100 },
    { hostEventId: 'id' },
    { hostEventId: 'id', hostCreatedAt: '100' },
    { hostEventId: 'id', hostCreatedAt: NaN },
    { hostEventId: 'id', hostCreatedAt: Infinity },
    { hostEventId: 'id', hostCreatedAt: 1e20 },
  ])('fails closed without a valid native identity/time: %j', async (supplementary) => {
    const input = await fixture();
    await expect(
      appendSessionErrorAuditOnce({ ...input, detail: { supplementary } }),
    ).rejects.toMatchObject({ code: 'PLUGIN_ENFORCEMENT_UNAVAILABLE' });
    expect(await readAuditTrail(input.sessDir)).toEqual([]);
  });
  it('surfaces a failed durable append and permits an honest retry', async () => {
    const input = await fixture();
    const failure = new persistence.PersistenceError(
      'WRITE_FAILED',
      'Injected durable write failure',
    );
    vi.spyOn(persistence, 'durableAtomicWrite').mockRejectedValueOnce(failure);
    await expect(appendSessionErrorAuditOnce(input)).rejects.toBe(failure);
    expect(await readAuditTrail(input.sessDir)).toEqual([]);
    await appendSessionErrorAuditOnce(input);
    expect(await readAuditTrail(input.sessDir)).toHaveLength(1);
  });
});
