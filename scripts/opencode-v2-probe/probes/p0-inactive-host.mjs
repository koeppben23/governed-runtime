#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProbeHost } from '../lib/host.mjs';

const outDir =
  process.env.FG_PROBE_OUT ??
  join(process.cwd(), 'scripts/opencode-v2-probe/evidence/p0-inactive-host');
await mkdir(outDir, { recursive: true });

function waitBounded(client, sessionID, timeoutMs = 20_000) {
  let timer;
  return Promise.race([
    client.session.wait({ sessionID }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`session.wait timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function runActivePlugin() {
  const host = await startProbeHost({
    name: 'p0-active',
    staticProvider: false,
    registerProvider: true,
    disableDefaultPlugins: true,
    policies: [{ action: 'provider.use', resource: 'opencode', effect: 'deny' }],
  });
  const result = { serverInfo: host.serverInfo, passed: false };
  try {
    await host.activate();
    const session = await host.session('p0 active');
    await host.prompt(session.id, 'Say plugin-provider-ok');
    await waitBounded(host.client, session.id);
    const context = await host.client.session.context({ sessionID: session.id });
    result.context = context.map((message) => ({
      type: message.type,
      id: message.id,
      finish: message.finish,
      text: typeof message.text === 'string' ? message.text : undefined,
      content: Array.isArray(message.content)
        ? message.content.map((part) => ({ type: part.type, text: part.text }))
        : undefined,
    }));
    result.providerRequests = host.provider.requests.length;
    result.providerRegistered = (await host.entries()).some(
      (entry) => entry.type === 'setup:provider-registered',
    );
    result.passed =
      result.providerRegistered &&
      result.providerRequests > 0 &&
      result.context.some((message) => message.type === 'assistant');
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runInactivePlugin() {
  const host = await startProbeHost({
    name: 'p0-inactive',
    staticProvider: false,
    registerProvider: true,
    failSetup: true,
    disableDefaultPlugins: true,
    policies: [{ action: 'provider.use', resource: 'opencode', effect: 'deny' }],
  });
  const result = {
    serverInfo: host.serverInfo,
    providerRequests: 0,
    promptError: null,
    promptAccepted: false,
    hooks: 0,
    passed: false,
  };
  try {
    await host.client.location.get();
    const session = await host.client.session.create({
      title: 'p0 inactive',
      location: { directory: host.project },
    });
    try {
      await host.prompt(session.id, 'This must not reach a provider.');
      await waitBounded(host.client, session.id);
      result.promptAccepted = true;
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    result.hooks = (await host.entries()).filter((entry) => entry.type.startsWith('hook:')).length;
    result.context = (await host.client.session.context({ sessionID: session.id })).map(
      (message) => ({
        type: message.type,
        id: message.id,
        finish: message.finish,
        outcome: message.outcome,
        error: message.error,
        agent: message.agent,
        model: message.model,
        text: typeof message.text === 'string' ? message.text : undefined,
        content: Array.isArray(message.content)
          ? message.content.map((part) => ({
              type: part.type,
              text:
                typeof part.text === 'string'
                  ? `${part.text.slice(0, 200)}${part.text.length > 200 ? '…[truncated]' : ''}`
                  : undefined,
              error: part.error,
            }))
          : undefined,
      }),
    );
    result.modelReached = result.providerRequests > 0;
    result.externalProviderReached = result.context.some(
      (message) =>
        message.type === 'assistant' &&
        message.model?.providerID !== undefined &&
        message.model.providerID !== 'probe',
    );
    // Admission may succeed while model resolution fails closed. The relevant
    // guarantee is that no provider request, including the host's built-in
    // fallback provider, and no hook execution occurred.
    result.passed =
      !result.modelReached && result.externalProviderReached === false && result.hooks === 0;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  return result;
}

async function runStaticProviderFailure() {
  const host = await startProbeHost({
    name: 'p0-static-failure',
    staticProvider: true,
    failSetup: true,
    disableDefaultPlugins: true,
    policies: [{ action: 'provider.use', resource: 'opencode', effect: 'deny' }],
  });
  const result = {
    serverInfo: host.serverInfo,
    providerRequests: 0,
    promptAccepted: false,
    passed: false,
  };
  try {
    await host.client.location.get();
    const session = await host.client.session.create({
      title: 'p0 static failure',
      location: { directory: host.project },
    });
    try {
      await host.prompt(session.id, 'This static provider must still work.');
      await waitBounded(host.client, session.id);
      result.promptAccepted = true;
    } catch (error) {
      result.promptError = String(error);
    }
    result.providerRequests = host.provider.requests.length;
    // This is a control: it demonstrates why a static provider defeats the
    // no-provider fail-closed gate.
    result.passed = result.promptAccepted && result.providerRequests > 0;
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await host.close();
  }
  return result;
}

const result = {
  at: new Date().toISOString(),
  active: await runActivePlugin(),
  inactive: await runInactivePlugin(),
  staticProviderFailureControl: await runStaticProviderFailure(),
};
result.passed = result.active.passed && result.inactive.passed;
result.status = result.passed
  ? 'SUPPORTED'
  : result.inactive.externalProviderReached
    ? 'NOT_SUPPORTED'
    : 'NOT_VERIFIED';
result.scope = {
  tested:
    'managed config, no static providers, built-in opencode provider denied, plugin-registered provider only',
  nonBypassable: false,
  limitation:
    'This is a configuration-level gate, not a host-side immutable lock. A host launched with a different config or an added static provider can bypass it; the control case demonstrates that a static provider keeps reaching the mock provider after plugin setup failure.',
};
result.reason = result.inactive.externalProviderReached
  ? 'Without a plugin-registered provider, the host fell back to the built-in opencode/big-pickle provider and reached an external provider. Removing the static provider is not a fail-closed runtime lock.'
  : undefined;
await writeFile(join(outDir, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
