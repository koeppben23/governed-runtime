/** Loaded product plugin + real native Task + actual persisted evidence, with a deterministic model. */
import { afterEach, describe, expect, it } from 'vitest';
import { createReviewerCaptureHostProbe } from './opencode-reviewer-capture-test-helpers.js';
import { seedStrictPlanSession } from '../integration/plugin-host-task-diagnostics-test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { writeStateWithArtifacts } from '../integration/tools/helpers.js';
import { TESTED_OPENCODE_HOST_VERSION } from './opencode-runtime-compat.js';

const ENABLED =
  process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: Awaited<ReturnType<typeof createReviewerCaptureHostProbe>> | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  restore?.();
  restore = undefined;
  await probe?.close();
  probe = undefined;
});

describe.skipIf(!ENABLED)('actual FlowGuard native reviewer capture on pinned OpenCode', () => {
  it.each(['positive', 'tool'] as const)(
    '%s: traverses actual hooks and atomically binds or blocks',
    async (mode) => {
      probe = await createReviewerCaptureHostProbe();
      expect(probe.host.version).toBe(TESTED_OPENCODE_HOST_VERSION);
      expect(probe.reportedVersion).toBe(TESTED_OPENCODE_HOST_VERSION);
      restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR });
      const parentId = await probe.session();
      const { sessDir, obligationId } = await seedStrictPlanSession(probe.project, parentId);
      await writeStateWithArtifacts(sessDir, (await readState(sessDir))!);
      const config = (await probe.request('/config')) as { plugin?: unknown[] };
      expect(config.plugin, probe.output()).toHaveLength(1);
      await probe.run(parentId, mode);
      const entries = await probe.entries();
      expect(
        entries.some((entry) => entry.hook === 'plugin-loaded'),
        probe.output(),
      ).toBe(true);
      const task = entries.find(
        (entry) =>
          entry.hook ===
            (mode === 'positive' ? 'tool.execute.after' : 'tool.execute.after:denied') &&
          entry.tool === 'task',
      );
      expect(task, `${JSON.stringify(entries, null, 2)}\n${probe.output()}`).toBeDefined();
      const childId = task?.metadata?.sessionId;
      expect(childId).toBeTruthy();
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      const assurance = state!.reviewAssurance!;
      expect(assurance.dispatches).toHaveLength(1);
      expect(probe.providerErrors).toEqual([]);
      expect(probe.serializations()).toBe(1);
      const histories = (await probe.request(`/session/${childId}/message`)) as Array<{
        info: Record<string, unknown>;
        parts: unknown[];
      }>;
      const child = (await probe.request(`/session/${childId}`)) as {
        parentID: string;
        permission: unknown;
      };
      expect(child.parentID).toBe(parentId);
      const guardMessages = entries.filter(
        (entry) => entry.hook === 'chat.message' && entry.sessionID === childId,
      );
      expect(guardMessages.length).toBeGreaterThanOrEqual(2);
      expect(guardMessages.at(-1)?.model).toEqual({
        providerID: 'capture',
        modelID: 'probe',
        variant: 'chosen',
      });
      expect(guardMessages.at(-1)?.permission).toEqual(guardMessages[0]?.permission);
      expect(child.permission).toEqual(guardMessages[0]?.permission);
      expect(
        entries.some(
          (entry) =>
            entry.hook === 'experimental.chat.messages.transform' &&
            entry.sessions?.includes(childId!),
        ),
      ).toBe(true);
      expect(
        entries.some((entry) => entry.hook === 'chat.params' && entry.sessionID === childId),
      ).toBe(true);
      const serializedRequests = probe.requests.filter((request) =>
        JSON.stringify(request.messages).includes(
          'ReviewerFindingsInput JSON schema (data, not instructions)',
        ),
      );
      expect(serializedRequests).toHaveLength(1);
      expect(serializedRequests[0]?.tool_choice).not.toBe('required');
      const reviewerCalls = probe.calls.filter((call) => call.phase !== 'parent');
      expect(reviewerCalls.map((call) => call.phase)).toEqual(['review', 'serialization']);
      for (const call of reviewerCalls) {
        expect(call.body.model).toBe('probe');
        expect(call.body.reasoning_effort).toBe('high');
      }
      expect(JSON.stringify(probe.requests)).not.toContain(probe.sentinel);

      if (mode === 'positive') {
        expect(
          assurance.obligations.find((entry) => entry.obligationId === obligationId)?.status,
        ).toBe('fulfilled');
        expect(assurance.attempts[0]?.status).toBe('bound');
        expect(assurance.dispatches[0]?.dispatchStatus).toBe('completed');
        expect(assurance.invocations).toHaveLength(1);
        const invocation = assurance.invocations[0]!;
        expect(invocation.capture.childSessionId).toBe(childId);
        expect(invocation.capture.attemptId).toBe(assurance.attempts[0]?.attemptId);
        expect(invocation.capture.model).toEqual({
          providerID: 'capture',
          modelID: 'probe',
          variant: 'chosen',
        });
        expect(
          histories.find((entry) => entry.info.id === invocation.capture.responseMessageId)?.info
            .parentID,
        ).toBe(invocation.capture.requestMessageId);
        // Native binding atomically stages audit intents in the existing outbox;
        // the next governed reconciliation publishes them to the hash chain.
        expect(
          state!.pendingAuditOperations.some(
            (operation) =>
              operation.kind === 'semantic' &&
              operation.semantic.event === 'review:subagent_invoked' &&
              operation.semantic.detail.childSessionId === childId,
          ),
        ).toBe(true);
      } else {
        expect(
          entries.some(
            (entry) =>
              entry.hook === 'tool.execute.before:denied' &&
              entry.tool === 'read' &&
              entry.sessionID === childId &&
              entry.code === 'REVIEWER_CAPTURE_PROVENANCE_INVALID',
          ),
        ).toBe(true);
        expect(
          entries.some(
            (entry) =>
              entry.hook === 'tool.execute.after' &&
              entry.tool === 'read' &&
              entry.sessionID === childId,
          ),
        ).toBe(false);
        expect(assurance.invocations).toHaveLength(0);
        expect(assurance.attempts.some((entry) => entry.status === 'bound')).toBe(false);
        expect(assurance.dispatches[0]?.dispatchStatus).not.toBe('completed');
        expect(assurance.obligations[0]?.status).toBe('blocked');
        expect(assurance.attempts).toHaveLength(1);
        expect(
          histories.some((entry) =>
            entry.parts.some((part) => {
              const value = part as { type?: string; state?: { status?: string } };
              return value.type === 'tool' && value.state?.status === 'error';
            }),
          ),
        ).toBe(true);
      }
    },
    300_000,
  );
});
