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
 * Configuration:
 * - FLOWGUARD_HOOK_PORT (env): port number (default: 18462)
 * - FLOWGUARD_HOOK_HOST (env): bind address (default: 127.0.0.1)
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/hooks (HTTP hook mode)
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 * @version v1
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolveSession } from './shared/session-resolver.js';
import { detectPlatform } from './shared/platform-detect.js';
import { formatDenyOutput } from './shared/stdout-writer.js';
import { validateToolHookPayload, validateSessionPayload } from './shared/stdin-reader.js';
import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  isSubagentAuthorized,
} from './shared/phase-gate.js';
import { assessObligationEscalation } from './shared/obligation-tracker.js';
import { appendAuditEvent } from '../adapters/persistence-audit.js';
import { ensureWorkspace, sessionDir } from '../adapters/workspace/index.js';
import type { AuditEvent } from '../state/evidence-audit.js';
import type { HookEventName, HttpHookResponse } from './shared/types.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_PORT = 18462;
const DEFAULT_HOST = '127.0.0.1';

const PORT = parseInt(process.env['FLOWGUARD_HOOK_PORT'] ?? '', 10) || DEFAULT_PORT;
const HOST = process.env['FLOWGUARD_HOOK_HOST'] ?? DEFAULT_HOST;

// ─── Request Handling ────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function log(message: string): void {
  process.stderr.write(`[FlowGuard HTTP Hook] ${message}\n`);
}

// ─── Hook Handlers ───────────────────────────────────────────────────────────

async function handlePreToolUse(payload: Record<string, unknown>): Promise<HttpHookResponse> {
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
  const auditEvent: AuditEvent = {
    id: randomUUID(),
    sessionId: session_id,
    phase: resolution.state.phase,
    event: 'tool_call',
    timestamp: now,
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
  } catch {
    // Non-blocking — audit failure does not affect response.
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

async function handleSessionStart(payload: Record<string, unknown>): Promise<HttpHookResponse> {
  const validated = validateSessionPayload(payload);
  const { session_id, cwd } = validated;
  const platform = detectPlatform(payload);

  try {
    await ensureWorkspace(cwd);
  } catch {
    return { decision: 'allow', reason: 'workspace bootstrap failed (non-blocking)' };
  }

  // Attempt audit event persistence.
  try {
    const { computeFingerprint } = await import('../adapters/workspace/index.js');
    const fpResult = await computeFingerprint(cwd);
    const sessDir = sessionDir(fpResult.fingerprint, session_id);
    const now = new Date().toISOString();
    const auditEvent: AuditEvent = {
      id: randomUUID(),
      sessionId: session_id,
      phase: 'READY',
      event: 'lifecycle',
      timestamp: now,
      actor: 'system',
      detail: { action: 'session_start', hookSource: 'http_hook', platform, cwd },
      enforcementLevel: 'hook_gated',
    };
    await appendAuditEvent(sessDir, auditEvent);
  } catch {
    // Acceptable — session may not be initialized yet.
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
  const pendingObligations =
    state.reviewAssurance?.obligations.filter(
      (ob) => ob.status !== 'consumed' && ob.consumedAt == null,
    ) ?? [];

  if (pendingObligations.length > 0) {
    log(
      `WARN: session ${session_id} ending with ${pendingObligations.length} pending obligation(s)`,
    );
  }

  const now = new Date().toISOString();
  const auditEvent: AuditEvent = {
    id: randomUUID(),
    sessionId: session_id,
    phase: state.phase,
    event: 'lifecycle',
    timestamp: now,
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
  } catch {
    // Non-blocking.
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

const ROUTES: Record<string, (payload: Record<string, unknown>) => Promise<HttpHookResponse>> = {
  '/hooks/pre-tool-use': handlePreToolUse,
  '/hooks/post-tool-use': handlePostToolUse,
  '/hooks/session-start': handleSessionStart,
  '/hooks/stop': handleStop,
};

/** Map route path to hook event name for deny response formatting. */
const ROUTE_EVENTS: Record<string, HookEventName> = {
  '/hooks/pre-tool-use': 'PreToolUse',
  '/hooks/post-tool-use': 'PostToolUse',
  '/hooks/session-start': 'SessionStart',
  '/hooks/stop': 'Stop',
};

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // Health check.
  if (method === 'GET' && url === '/health') {
    jsonResponse(res, 200, { status: 'ok', port: PORT, pid: process.pid });
    return;
  }

  // Only POST for hook endpoints.
  if (method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return;
  }

  const handler = ROUTES[url];
  if (!handler) {
    jsonResponse(res, 404, { error: `Unknown route: ${url}` });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    jsonResponse(res, 400, { error: 'Failed to read request body' });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      jsonResponse(res, 400, { error: 'Request body must be a JSON object' });
      return;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON in request body' });
    return;
  }

  try {
    const result = await handler(payload);

    // For pre-tool-use denials, also include the hookSpecificOutput format
    // so Claude Code can interpret it directly.
    if (result.decision === 'deny' && url === '/hooks/pre-tool-use') {
      const eventName = ROUTE_EVENTS[url]!;
      const denyOutput = formatDenyOutput(eventName, result.code ?? 'DENIED', result.reason ?? '');
      jsonResponse(res, 200, { ...result, ...denyOutput });
    } else {
      jsonResponse(res, 200, result);
    }
  } catch (err) {
    log(`ERROR: ${url} handler failed: ${err instanceof Error ? err.message : String(err)}`);
    // Fail-closed for pre-tool-use: return deny on internal error.
    if (url === '/hooks/pre-tool-use') {
      const eventName = ROUTE_EVENTS[url]!;
      const denyOutput = formatDenyOutput(
        eventName,
        'INTERNAL_ERROR',
        `Hook server internal error: ${err instanceof Error ? err.message : String(err)}`,
      );
      jsonResponse(res, 200, { decision: 'deny', ...denyOutput });
    } else {
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
  log(`PID: ${process.pid}`);
  log(`routes: ${Object.keys(ROUTES).join(', ')}`);
});

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
