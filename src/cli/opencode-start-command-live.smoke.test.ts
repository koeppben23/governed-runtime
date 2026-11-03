/** Actual pinned host: native `/start` through the real plugin command channel.
 * The command is invoked through the SDK, which the host cannot distinguish from
 * operator UI input; the decision is therefore `host_command`, never human proof. */
import { afterEach, describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import type { SessionMessageAssistantTool } from '@opencode/client';
import { createNativeHostProbe, type NativeHostProbe } from './opencode-native-test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';

const LIVE = process.env.OPENCODE_LIVE === '1' || process.env.FLOWGUARD_OPENCODE_HOST_E2E === '1';
let probe: NativeHostProbe | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
  try {
    await probe?.close();
  } finally {
    restore?.();
    probe = undefined;
    restore = undefined;
  }
});

const FAIL_FIRST_ACTIVATION_AUDIT_CONFIRMATION = `
const originalSet = ctx.storage.set.bind(ctx.storage);
let failed = false;
ctx.storage.set = async (key, value) => {
  if (!failed && key.endsWith('/audit-confirmation')) {
    failed = true;
    throw new Error('activation audit confirmation write failed');
  }
  return originalSet(key, value);
};
return undefined;
`;

function productiveTools(request: { body: Record<string, unknown> }): string[] {
  const tools = (request.body.tools ?? []) as Array<{ function?: { name: string } }>;
  return tools
    .map((tool) => tool.function?.name ?? '')
    .filter((name) => name.startsWith('flowguard_') && name !== 'flowguard_help');
}

describe.skipIf(!LIVE)('native /start command on the pinned host', () => {
  it('activates only the invoked root session, survives restart and leaves siblings native', async () => {
    probe = await createNativeHostProbe({ product: true, script: () => ({ text: 'Done.' }) });
    restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR! });
    const commands = await probe.client.command.list({ location: probe.location });
    expect(commands.data.map((command) => command.name)).toContain('start');

    const governed = await probe.session();
    await probe.prompt(governed.id, 'Before start.');
    expect(productiveTools(probe.requests.at(-1)!)).toEqual([]);
    const before = probe.requests.length;

    await probe.client.session.command({ sessionID: governed.id, name: 'start', text: '' });
    await probe.client.session.wait(
      { sessionID: governed.id },
      { signal: AbortSignal.timeout(120_000) },
    );
    // The non-resuming report must not start a model turn by itself.
    expect(probe.requests.length, probe.output()).toBe(before);
    const authority = await resolveSessionAuthority({
      root: await realpath(probe.project),
      sessionId: governed.id,
    });
    expect(authority.status, probe.output()).toBe('resolved');
    // The report exists right after /start: delivered to history or pending in
    // the inbox (a non-resuming synthetic item). Record where, never guess.
    const report = 'FlowGuard governance is ACTIVE';
    let location: 'history' | 'inbox' | undefined;
    for (let attempt = 0; attempt < 40 && location === undefined; attempt++) {
      if (
        JSON.stringify(await probe.client.session.context({ sessionID: governed.id })).includes(
          report,
        )
      )
        location = 'history';
      else if (
        JSON.stringify(await probe.client.session.inbox.list({ sessionID: governed.id })).includes(
          report,
        )
      )
        location = 'inbox';
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log('[start-report-location]', location);
    expect(location, probe.output()).toBeDefined();
    expect(probe.requests.length).toBe(before);

    if (authority.status !== 'resolved') throw new Error('Expected native Start workflow');
    const activationEvents = (await readAuditTrail(authority.sessDir)).filter(
      (event) => event.event === 'governance:activated',
    );
    expect(activationEvents).toHaveLength(1);
    expect(activationEvents[0]).toMatchObject({
      hostSessionId: governed.id,
      actorInfo: {
        id: expect.any(String),
        source: expect.any(String),
        assurance: expect.any(String),
      },
      detail: {
        channel: 'host_command',
        generation: 1,
        rootSessionId: governed.id,
        policyDigest: authority.state.policySnapshot.hash,
        worktreeRoot: authority.worktreeRoot,
      },
    });
    await probe.client.session.command({ sessionID: governed.id, name: 'start', text: '' });
    await probe.client.session.wait(
      { sessionID: governed.id },
      { signal: AbortSignal.timeout(120_000) },
    );
    const repeated = await resolveSessionAuthority({
      root: authority.worktreeRoot,
      sessionId: governed.id,
    });
    expect(repeated.status === 'resolved' ? repeated.state : repeated).toEqual(authority.state);
    expect(
      (await readAuditTrail(authority.sessDir)).filter(
        (event) => event.event === 'governance:activated',
      ),
    ).toEqual(activationEvents);
    await probe.prompt(governed.id, 'After start.');
    // resume:false admits a synthetic report without waking the model. The
    // next user turn delivers it into history; admission is not transcript delivery.
    const history = await probe.client.session.context({ sessionID: governed.id });
    expect(JSON.stringify(history), probe.output()).toContain('FlowGuard governance is ACTIVE');
    expect(productiveTools(probe.requests.at(-1)!)).toContain('flowguard_status');
    // At the latest the next turn carries the report into the conversation.
    expect(JSON.stringify(probe.requests.at(-1)!.body.messages)).toContain(report);

    await probe.restart('SIGKILL');
    await probe.prompt(governed.id, 'After restart.');
    expect(productiveTools(probe.requests.at(-1)!)).toContain('flowguard_status');
    await probe.client.session.command({ sessionID: governed.id, name: 'start', text: '' });
    await probe.client.session.wait(
      { sessionID: governed.id },
      { signal: AbortSignal.timeout(120_000) },
    );
    const audit = await readAuditTrail(authority.sessDir);
    expect(audit.filter((event) => event.event === 'governance:activated')).toEqual(
      activationEvents,
    );
    expect(verifyChain(audit).valid).toBe(true);

    const sibling = await probe.session();
    await probe.prompt(sibling.id, 'Ordinary sibling.');
    expect(productiveTools(probe.requests.at(-1)!)).toEqual([]);
    expect(probe.errors).toEqual([]);
  }, 300_000);

  it('blocks a governed workflow tool until a missing activation-audit confirmation is repaired', async () => {
    let governedID = '';
    let promptReady = false;
    let stage = 0;
    probe = await createNativeHostProbe({
      product: true,
      productTestSetup: FAIL_FIRST_ACTIVATION_AUDIT_CONFIRMATION,
      script(_body, sessionID) {
        if (sessionID !== governedID || !promptReady) return { text: 'Done.' };
        const replies = [
          {
            tool: {
              name: 'flowguard_ticket',
              arguments: { text: 'audit gate probe after repair' },
            },
          },
          { text: 'Recovered probe observed.' },
        ] as const;
        const reply = replies[stage] ?? { text: 'Done.' };
        stage++;
        return reply;
      },
    });
    restore = withTestEnv({ OPENCODE_CONFIG_DIR: probe.env.OPENCODE_CONFIG_DIR! });
    const commands = await probe.client.command.list({ location: probe.location });
    expect(commands.data.map((command) => command.name)).toContain('start');
    const governed = await probe.session();
    governedID = governed.id;
    await probe.prompt(governed.id, 'Before start.');
    promptReady = true;

    let startFailure: unknown;
    try {
      await probe.client.session.command({ sessionID: governed.id, name: 'start', text: '' });
    } catch (error) {
      startFailure = error;
    }
    await probe.client.session
      .wait({ sessionID: governed.id }, { signal: AbortSignal.timeout(120_000) })
      .catch(() => {});
    expect(startFailure, probe.output()).toBeDefined();
    const authority = await resolveSessionAuthority({
      root: await realpath(probe.project),
      sessionId: governed.id,
    });
    if (authority.status !== 'resolved')
      throw new Error(
        `Expected native Start workflow: ${JSON.stringify(authority)} ${probe.output()}`,
      );
    const activationEvents = (await readAuditTrail(authority.sessDir)).filter(
      (event) => event.event === 'governance:activated',
    );
    expect(activationEvents).toHaveLength(1);

    // The activation audit event exists, but its durable confirmation write was
    // injected to fail. No model turn or workflow tool may execute until /start
    // retries the confirmation.
    let blockedPrompt: unknown;
    try {
      await probe.prompt(governed.id, 'Attempt a governed workflow tool before repair.');
    } catch (error) {
      blockedPrompt = error;
    }
    // The host surfaces the refused runtime admission as an HTTP 500 at the
    // prompt boundary; no model turn or workflow tool executed.
    expect(blockedPrompt, probe.output()).toBeDefined();
    const blockedHistory = await probe.client.session.context({ sessionID: governed.id });
    const blockedTools = blockedHistory
      .flatMap((message) => (message.type === 'assistant' ? message.content : []))
      .filter(
        (part): part is SessionMessageAssistantTool =>
          part.type === 'tool' && part.name === 'flowguard_ticket',
      );
    expect(blockedTools, JSON.stringify(blockedHistory)).toEqual([]);
    const blockedAuthority = await resolveSessionAuthority({
      root: authority.worktreeRoot,
      sessionId: governed.id,
    });
    if (blockedAuthority.status !== 'resolved') throw new Error('Expected workflow');
    expect(blockedAuthority.state.phase).toBe('READY');

    await probe.client.session.command({ sessionID: governed.id, name: 'start', text: '' });
    await probe.client.session.wait(
      { sessionID: governed.id },
      { signal: AbortSignal.timeout(120_000) },
    );
    const repaired = (await readAuditTrail(authority.sessDir)).filter(
      (event) => event.event === 'governance:activated',
    );
    expect(repaired).toHaveLength(1);
    expect(repaired[0]!.id).toBe(activationEvents[0]!.id);

    await probe.prompt(governed.id, 'Attempt a governed workflow tool after repair.');
    const recoveredHistory = await probe.client.session.context({ sessionID: governed.id });
    const recoveredTools = recoveredHistory
      .flatMap((message) => (message.type === 'assistant' ? message.content : []))
      .filter(
        (part): part is SessionMessageAssistantTool =>
          part.type === 'tool' && part.name === 'flowguard_ticket',
      );
    expect(recoveredTools, JSON.stringify(recoveredHistory)).toHaveLength(1);
    expect(recoveredTools[0]!.state.status, JSON.stringify(recoveredTools[0])).toBe('completed');
    const recoveredAuthority = await resolveSessionAuthority({
      root: authority.worktreeRoot,
      sessionId: governed.id,
    });
    if (recoveredAuthority.status !== 'resolved') throw new Error('Expected workflow');
    expect(recoveredAuthority.state.phase).toBe('TICKET');
    expect(verifyChain(await readAuditTrail(authority.sessDir)).valid).toBe(true);
    expect(probe.errors).toEqual([]);
  }, 300_000);
});
