#!/usr/bin/env node
/**
 * @module hooks/http-server
 * @description FlowGuard HTTP Hook Server — persistent endpoint for Claude Code HTTP hooks.
 *
 * Provides a localhost HTTP server that handles hook events with sub-20ms latency
 * (vs ~100-200ms for process-spawn command hooks). Uses Node's built-in `node:http`
 * module — zero external dependencies.
 *
 * Claude Code supports `"type": "http"` hooks that send POST requests to a running
 * server instead of spawning a new process per hook invocation.
 *
 * Endpoints:
 * - POST /hooks/pre-tool-use   → Phase gate evaluation
 * - POST /hooks/post-tool-use  → Audit persistence
 * - POST /hooks/session-start  → Workspace bootstrap
 * - POST /hooks/stop           → Cleanup and review check
 * - GET  /health               → Server liveness check
 *
 * Fail-closed transport (PreToolUse only): Claude Code treats non-2xx HTTP hook
 * responses as non-blocking, so every handler-reachable pre-tool-use validation
 * or body-read failure after authentication, method, and route resolution
 * (content type, body read, oversized payload, malformed JSON) is delivered as
 * HTTP 200 with a protocol DENY body. Authentication (401), method (405),
 * unknown route (404), an unreachable server, client disconnect, and timeout
 * cannot be converted into a DENY from inside the server and remain documented
 * non-blocking residual risks; the informational routes keep their status
 * codes. See docs/platform-limitations.md (Gap 3).
 *
 * Configuration:
 * - FLOWGUARD_HOOK_PORT (env): port number (default: 18462)
 * - FLOWGUARD_HOOK_HOST (env): bind address (default: 127.0.0.1)
 * - FLOWGUARD_HOOK_TOKEN (env): required bearer token for governance routes
 * - FLOWGUARD_HOOK_ALLOW_REMOTE (env): set to 1 to allow a non-loopback bind
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/hooks (HTTP hook mode)
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 * @version v1
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveSession } from './shared/session-resolver.js';
import { detectPlatform } from './shared/platform-detect.js';
import { formatDenyOutput } from './shared/stdout-writer.js';
import { validateToolHookPayload, validateSessionPayload } from './shared/stdin-reader.js';
import {
  headerValues,
  jsonResponse,
  protocolDenyEventFor,
  readHookPayloadOrRespond,
} from './shared/http-transport.js';
import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  isSubagentAuthorized,
} from './shared/phase-gate.js';
import {
  assessObligationEscalation,
  formatUnresolvedBlockingObligationReason,
  unresolvedBlockingObligations,
} from './shared/obligation-tracker.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { ensureWorkspace } from '../adapters/workspace/index.js';
import { resolveRoot } from '../adapters/git.js';
import type { AuditEventBody } from '../state/evidence-audit.js';
import type { HookEventName, HttpHookResponse } from './shared/types.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_PORT = 18462;
const DEFAULT_HOST = '127.0.0.1';
const MINIMUM_HOOK_TOKEN_LENGTH = 32;

export type HttpHookServerConfig =
  | {
      readonly binding: 'loopback';
      readonly host: '127.0.0.1' | '::1';
      readonly port: number;
      readonly token: string;
    }
  | {
      readonly binding: 'remote';
      readonly host: string;
      readonly port: number;
      readonly token: string;
      readonly allowRemote: true;
    };

function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined) return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(rawPort)) {
    throw new TypeError('FLOWGUARD_HOOK_PORT must be an integer from 1 through 65535');
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('FLOWGUARD_HOOK_PORT must be an integer from 1 through 65535');
  }
  return port;
}

function readRequiredHookToken(env: Readonly<Record<string, string | undefined>>): string {
  const token = env['FLOWGUARD_HOOK_TOKEN'];
  if (token === undefined || token.trim().length < MINIMUM_HOOK_TOKEN_LENGTH || /\s/.test(token)) {
    throw new TypeError(
      'FLOWGUARD_HOOK_TOKEN must contain at least 32 non-whitespace characters and is required',
    );
  }
  return token;
}

function readAllowRemoteFlag(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env['FLOWGUARD_HOOK_ALLOW_REMOTE'];
  if (raw !== undefined && raw !== '' && raw !== '1') {
    throw new TypeError('FLOWGUARD_HOOK_ALLOW_REMOTE must be exactly 1 when set');
  }
  return raw ?? '';
}

/** Validates all externally supplied HTTP listener configuration before binding. */
export function readHttpHookServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HttpHookServerConfig {
  const host = env['FLOWGUARD_HOOK_HOST'] ?? DEFAULT_HOST;
  if (host.length === 0) throw new TypeError('FLOWGUARD_HOOK_HOST must not be empty');

  const token = readRequiredHookToken(env);
  const allowRemoteRaw = readAllowRemoteFlag(env);
  const port = parsePort(env['FLOWGUARD_HOOK_PORT']);

  if (host === '127.0.0.1' || host === '::1') {
    return { binding: 'loopback', host, port, token };
  }
  if (allowRemoteRaw !== '1') {
    throw new TypeError(
      'FLOWGUARD_HOOK_HOST is non-loopback; set FLOWGUARD_HOOK_ALLOW_REMOTE=1 with an explicit token to allow it',
    );
  }
  return { binding: 'remote', host, port, token, allowRemote: true };
}

let serverConfig: HttpHookServerConfig | undefined;

// ─── Request Handling ────────────────────────────────────────────────────────

function secureTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isAuthorizedHookRequest(req: IncomingMessage, token: string): boolean {
  const authorization = headerValues(req, 'authorization');
  const [authorizationHeader] = authorization;
  if (authorization.length !== 1 || authorizationHeader === undefined) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader);
  if (match === null) return false;
  const [, bearerToken] = match;
  return bearerToken !== undefined && secureTokenEquals(bearerToken, token);
}

function log(message: string): void {
  process.stderr.write(`[FlowGuard HTTP Hook] ${message}\n`);
}

// ─── Hook Handlers ───────────────────────────────────────────────────────────

/** @internal Exported for unit testing only. */
export async function handlePreToolUse(
  payload: Record<string, unknown>,
): Promise<HttpHookResponse> {
  const validated = validateToolHookPayload(payload);
  const { tool_name, tool_input, session_id, cwd } = validated;
  const toolNameLower = tool_name.toLowerCase();

  // Defense-in-depth: subagent authorization check.
  const subagentGate = isSubagentAuthorized(toolNameLower, tool_input);
  if (!subagentGate.allowed) {
    return { decision: 'deny', code: subagentGate.code, reason: subagentGate.reason };
  }

  // Fast path: non-mutating → allow.
  if (!isMutatingHostTool(toolNameLower)) {
    return { decision: 'allow' };
  }

  const resolution = await resolveSession(cwd, session_id);
  if (!resolution.ok) {
    return { decision: 'deny', code: resolution.code, reason: resolution.reason };
  }

  const unresolved = unresolvedBlockingObligations(resolution.state);
  if (unresolved.length > 0) {
    return {
      decision: 'deny',
      code: 'REVIEW_OBLIGATION_UNRESOLVED',
      reason: formatUnresolvedBlockingObligationReason(unresolved),
    };
  }

  const gateResult = isHostToolAllowedInPhase(toolNameLower, resolution.state.phase);
  if (!gateResult.allowed) {
    return { decision: 'deny', code: gateResult.code, reason: gateResult.reason };
  }

  return { decision: 'allow' };
}

async function handlePostToolUse(payload: Record<string, unknown>): Promise<HttpHookResponse> {
  const validated = validateToolHookPayload(payload);
  const { tool_name, tool_input, session_id, cwd } = validated;
  const platform = detectPlatform(payload);

  const resolution = await resolveSession(cwd, session_id);
  if (!resolution.ok) {
    return { decision: 'allow', reason: `audit skipped: ${resolution.code}` };
  }

  const now = new Date().toISOString();
  const auditEvent: AuditEventBody = {
    id: randomUUID(),
    flowguardSessionId: resolution.state.flowguardSessionId,
    hostSessionId: session_id,
    phase: resolution.state.phase,
    event: 'tool_call',
    occurredAt: now,
    actor: 'machine',
    detail: {
      tool: tool_name,
      input: truncateInput(tool_input),
      hookSource: 'http_hook',
      platform,
    },
    enforcementLevel: 'hook_gated',
  };

  try {
    await appendAuditEvent(resolution.sessionDir, auditEvent);
  } catch (err) {
    log(
      `WARN: audit-append-failed (post-tool-use): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Gap 4 mitigation: escalating warnings for pending review obligations.
  const escalation = assessObligationEscalation(
    resolution.state,
    isMutatingHostTool(tool_name.toLowerCase()),
    now,
  );
  if (escalation.message) {
    log(escalation.message);
  }

  return { decision: 'allow' };
}

/** @internal Exported for unit testing only. */
export async function handleSessionStart(
  payload: Record<string, unknown>,
): Promise<HttpHookResponse> {
  const validated = validateSessionPayload(payload);
  const { session_id, cwd } = validated;
  const platform = detectPlatform(payload);

  // Workspace bootstrap runs only on the git-resolved worktree root; the raw
  // payload cwd is never a filesystem authority. An active
  // FLOWGUARD_SESSION_DIR override skips bootstrap entirely.
  const envOverride = process.env['FLOWGUARD_SESSION_DIR'];
  if (envOverride === undefined || envOverride.length === 0) {
    try {
      const worktreeRoot = await resolveRoot(cwd);
      await ensureWorkspace(worktreeRoot);
    } catch (err) {
      log(`WARN: workspace-bootstrap-failed: ${err instanceof Error ? err.message : String(err)}`);
      return { decision: 'allow', reason: 'workspace bootstrap failed (non-blocking)' };
    }
  }

  // Resolve the governed session. Audit v3 events require the explicit
  // FlowGuard identity; without resolved state the session_start event is
  // skipped — no polymorphic sessionId records.
  let resolution: Awaited<ReturnType<typeof resolveSession>>;
  try {
    resolution = await resolveSession(cwd, session_id);
  } catch (err) {
    log(
      `INFO: session resolution failed (session-start): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { decision: 'allow' };
  }
  if (!resolution.ok) {
    log(`INFO: session state not available (${resolution.code}) — session_start audit skipped`);
    return { decision: 'allow' };
  }

  try {
    const now = new Date().toISOString();
    const auditEvent: AuditEventBody = {
      id: randomUUID(),
      flowguardSessionId: resolution.state.flowguardSessionId,
      hostSessionId: session_id,
      phase: 'READY',
      event: 'lifecycle',
      occurredAt: now,
      actor: 'system',
      detail: { action: 'session_start', hookSource: 'http_hook', platform, cwd },
      enforcementLevel: 'hook_gated',
    };
    await appendAuditEvent(resolution.sessionDir, auditEvent);
  } catch (err) {
    log(
      `WARN: audit-append-failed (session-start): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { decision: 'allow' };
}

async function handleStop(payload: Record<string, unknown>): Promise<HttpHookResponse> {
  const validated = validateSessionPayload(payload);
  const { session_id, cwd } = validated;
  const platform = detectPlatform(payload);

  const resolution = await resolveSession(cwd, session_id);
  if (!resolution.ok) {
    return { decision: 'allow' };
  }

  const { state, sessionDir: sessDir } = resolution;
  const pendingObligations = unresolvedBlockingObligations(state);

  if (pendingObligations.length > 0) {
    log(
      `WARN: session ${session_id} ending with ${pendingObligations.length} pending obligation(s)`,
    );
  }

  const now = new Date().toISOString();
  const auditEvent: AuditEventBody = {
    id: randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: session_id,
    phase: state.phase,
    event: 'lifecycle',
    occurredAt: now,
    actor: 'system',
    detail: {
      action: 'session_stop',
      hookSource: 'http_hook',
      platform,
      pendingObligations: pendingObligations.length,
      finalPhase: state.phase,
    },
    enforcementLevel: 'hook_gated',
  };

  try {
    await appendAuditEvent(sessDir, auditEvent);
  } catch (err) {
    log(
      `WARN: audit-append-failed (session-stop): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { decision: 'allow' };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function truncateInput(input: Record<string, unknown>): Record<string, unknown> {
  const MAX = 500;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > MAX) {
      result[key] = value.slice(0, MAX) + `... [truncated, ${value.length} chars]`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Router ──────────────────────────────────────────────────────────────────

interface HookRoute {
  readonly event: HookEventName;
  readonly handle: (payload: Record<string, unknown>) => Promise<HttpHookResponse>;
}

const ROUTES: Record<string, HookRoute> = {
  '/hooks/pre-tool-use': { event: 'PreToolUse', handle: handlePreToolUse },
  '/hooks/post-tool-use': { event: 'PostToolUse', handle: handlePostToolUse },
  '/hooks/session-start': { event: 'SessionStart', handle: handleSessionStart },
  '/hooks/stop': { event: 'Stop', handle: handleStop },
};

// ─── Server ──────────────────────────────────────────────────────────────────

async function dispatchHookRoute(
  url: string,
  route: HookRoute,
  payload: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  try {
    const result = await route.handle(payload);

    // For pre-tool-use denials, also include the hookSpecificOutput format
    // so Claude Code can interpret it directly.
    if (result.decision === 'deny' && url === '/hooks/pre-tool-use') {
      const denyOutput = formatDenyOutput(
        route.event,
        result.code ?? 'DENIED',
        result.reason ?? '',
      );
      jsonResponse(res, 200, { ...result, ...denyOutput });
    } else {
      jsonResponse(res, 200, result);
    }
  } catch (err) {
    log(`ERROR: ${url} handler failed: ${err instanceof Error ? err.message : String(err)}`);
    // Fail-closed for pre-tool-use: return deny on internal error.
    if (url === '/hooks/pre-tool-use') {
      const denyOutput = formatDenyOutput(
        route.event,
        'INTERNAL_ERROR',
        `Hook server internal error: ${err instanceof Error ? err.message : String(err)}`,
      );
      jsonResponse(res, 200, { decision: 'deny', ...denyOutput });
    } else {
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  }
}

/** @internal Exported for unit testing only. */
export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // Health check.
  if (method === 'GET' && url === '/health') {
    jsonResponse(res, 200, { status: 'ok' });
    return;
  }

  // All governance requests authenticate before dispatch so callers without a
  // token cannot distinguish routes or supported methods.
  if (serverConfig === undefined || !isAuthorizedHookRequest(req, serverConfig.token)) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return;
  }

  // Only POST for hook endpoints.
  if (method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return;
  }

  const route = ROUTES[url];
  if (!route) {
    jsonResponse(res, 404, { error: `Unknown route: ${url}` });
    return;
  }

  const payload = await readHookPayloadOrRespond(req, res, protocolDenyEventFor(route.event));
  if (payload === undefined) return;

  await dispatchHookRoute(url, route, payload, res);
}

const server = createServer(handleHttpRequest);

function startServer(): void {
  let config: HttpHookServerConfig;
  try {
    config = readHttpHookServerConfig();
  } catch (err) {
    log(`ERROR: invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  serverConfig = config;

  server.listen(config.port, config.host, () => {
    log(`listening on ${config.host}:${config.port}`);
    log(`PID: ${process.pid}`);
    log(`routes: ${Object.keys(ROUTES).join(', ')}`);
  });
}

startServer();

// Graceful shutdown.
function shutdown(): void {
  log('shutting down...');
  server.close(() => {
    log('server closed');
    process.exit(0);
  });
  // Force close after 5s.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
