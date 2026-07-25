/**
 * @module integration/review/__tests__/parallel-host-probe-live.test
 * @description Strang 2 (#732) — LIVE run of the parallel host-probe harness
 * against a REAL `opencode serve` instance.
 *
 * GATED: this suite is skipped unless BOTH environment variables are set:
 *   OPENCODE_LIVE=1              enable the live run
 *   OPENCODE_CLI=<path|command>  the opencode CLI to spawn `serve` with
 * Without them the suite is a no-op, so `npm test` / CI never depend on a host.
 *
 * HONESTY CONTRACT: unlike the fake-client self-consistency checks, THIS suite
 * is real host evidence. It drives the exact same FlowGuard `runParallelProbe`
 * harness (not a re-implementation) through a thin `fetch` REST adapter over the
 * documented opencode HTTP API. It answers the Gap 8 open question: does a real
 * host run bounded, parallel, read-only child sessions of one parent with unique
 * identity, deterministic completion, and observable completion ordering?
 *
 * It uses raw `fetch` (no @opencode-ai/sdk import — that package is not a
 * declared dependency) and a free model to avoid cost.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  runParallelProbe,
  type ProbeReport,
  type ProbeRequest,
} from './parallel-host-probe-harness.js';
import type { OrchestratorClient } from '../types.js';
import { extractStructuredOutputToolPart } from '../structured-output-tool-part.js';

const LIVE = process.env.OPENCODE_LIVE === '1' && !!process.env.OPENCODE_CLI;

// A free model keeps the parallelism run zero-cost; overridable if unavailable.
const PROVIDER_ID = process.env.OPENCODE_PROBE_PROVIDER ?? 'opencode';
const MODEL_ID = process.env.OPENCODE_PROBE_MODEL ?? 'deepseek-v4-flash-free';
// Structured output requires a tool-calling-capable model; the free tier did not
// emit tool calls in probing, so the structured check uses a capable default.
const STRUCTURED_PROVIDER_ID = process.env.OPENCODE_PROBE_STRUCTURED_PROVIDER ?? 'github-copilot';
const STRUCTURED_MODEL_ID = process.env.OPENCODE_PROBE_STRUCTURED_MODEL ?? 'claude-sonnet-4.6';
const PROJECT_DIR = process.cwd().replace(/\\/g, '/');
const PROMPT_TIMEOUT_MS = 120_000;

interface ServeHandle {
  proc: ChildProcess;
  baseUrl: string;
  password: string;
}

function randomPort(): number {
  return 18080 + Math.floor(Math.random() * 1500);
}

/** Start `opencode serve`, resolve once it prints its listening URL. */
async function startServe(cli: string): Promise<ServeHandle> {
  const port = randomPort();
  const password = `probe-${Math.random().toString(36).slice(2)}`;
  const proc = spawn(cli, ['serve', '--hostname=127.0.0.1', `--port=${port}`, '--print-logs'], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('serve did not report listening in 30s')),
      30_000,
    );
    const onData = (buf: Buffer): void => {
      const text = buf.toString('utf8');
      const match = text.match(/listening on\s+(https?:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!.trim());
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early with code ${String(code)}`));
    });
  });

  return { proc, baseUrl, password };
}

async function stopServe(handle: ServeHandle | undefined): Promise<void> {
  if (!handle || handle.proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    handle.proc.once('close', () => resolve());
    handle.proc.kill('SIGTERM');
    setTimeout(() => {
      if (handle.proc.exitCode === null) handle.proc.kill('SIGKILL');
    }, 5_000);
  });
}

/**
 * Thin REST adapter mapping the documented opencode HTTP API onto the
 * OrchestratorClient shape the harness expects. Uses raw fetch + Basic auth.
 */
function makeRestClient(handle: ServeHandle): OrchestratorClient {
  const dir = encodeURIComponent(PROJECT_DIR);
  const auth = `Basic ${Buffer.from(`opencode:${handle.password}`).toString('base64')}`;
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };

  return {
    app: {
      agents: async () => {
        const res = await fetch(`${handle.baseUrl}/agent?directory=${dir}`, { headers });
        if (!res.ok) return { data: undefined, error: { message: `agents ${res.status}` } };
        return { data: (await res.json()) as Array<Record<string, unknown>> };
      },
    },
    session: {
      create: async (opts) => {
        const res = await fetch(`${handle.baseUrl}/session?directory=${dir}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(opts.body ?? {}),
        });
        if (!res.ok) return { data: undefined, error: { message: `create ${res.status}` } };
        const body = (await res.json()) as { id?: string };
        return body.id
          ? { data: { id: body.id } }
          : { data: undefined, error: { message: 'no id' } };
      },
      prompt: async (opts) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROMPT_TIMEOUT_MS);
        try {
          const res = await fetch(
            `${handle.baseUrl}/session/${opts.path.id}/message?directory=${dir}`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                parts: opts.body.parts,
                model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
              }),
              signal: controller.signal,
            },
          );
          if (!res.ok) return { data: undefined, error: { message: `prompt ${res.status}` } };
          const body = (await res.json()) as {
            info?: { finish?: string; error?: unknown; time?: { completed?: number } };
            parts?: Array<{ type?: string; text?: string }>;
          };
          // A host-side abort surfaces as an error on the message info.
          if (body.info?.error) {
            return { data: undefined, error: new Error('aborted') };
          }
          return { data: { parts: body.parts, info: { structured_output: undefined } } };
        } finally {
          clearTimeout(timer);
        }
      },
      abort: async (opts) => {
        const res = await fetch(
          `${handle.baseUrl}/session/${opts.path.id}/abort?directory=${dir}`,
          {
            method: 'POST',
            headers,
          },
        );
        return res.ok ? { data: true } : { data: false, error: { message: `abort ${res.status}` } };
      },
    },
  };
}

function requests(n: number): ProbeRequest[] {
  return Array.from({ length: n }, (_, i) => ({
    prompt: `Reply with exactly one word: PONG (probe ${i})`,
  }));
}

describe.skipIf(!LIVE)('LIVE parallel host-probe (#732 Strang 2)', () => {
  let handle: ServeHandle | undefined;

  beforeAll(async () => {
    handle = await startServe(process.env.OPENCODE_CLI!);
  }, 40_000);

  afterAll(async () => {
    await stopServe(handle);
  });

  it(
    'runs bounded parallel read-only child sessions of one parent',
    async () => {
      const client = makeRestClient(handle!);

      // Confirm the host resolves agents (capability sanity) before probing.
      const agents = await client.app.agents();
      expect(agents.error).toBeUndefined();

      // Create the parent session the children attach to.
      const parent = await client.session.create({
        body: { title: 'FlowGuard Host Probe Parent' },
      });
      expect(parent.data?.id).toBeTruthy();
      const parentSessionId = parent.data!.id;

      const N = 4;
      const maxConcurrency = 3;
      const report: ProbeReport = await runParallelProbe({
        client,
        parentSessionId,
        requests: requests(N),
        maxConcurrency,
      });

      // Emit the evidence for out-of-band analysis (Gap 8 verification path).
      console.log('[host-probe-evidence]', JSON.stringify({ report }, null, 2));

      // Structural guarantees regardless of host concurrency behavior:
      expect(report.results).toHaveLength(N);
      const childIds = report.results.map((r) => r.childSessionId).filter(Boolean);
      expect(new Set(childIds).size).toBe(childIds.length); // unique identity
      const sequences = report.results.map((r) => r.completionSequence).sort((a, b) => a - b);
      expect(sequences).toEqual([1, 2, 3, 4]); // complete completion ordering

      // The bound must never be exceeded (FlowGuard-owned guarantee).
      expect(report.peakObservedConcurrency).toBeLessThanOrEqual(maxConcurrency);
      expect(report.peakObservedConcurrency).toBeGreaterThanOrEqual(1);

      // NOTE: whether peakObservedConcurrency > 1 (true host parallelism) vs. 1
      // (host serializes prompts) is the Gap 8 measurement — reported above, not
      // asserted here, because either outcome is a valid honest finding.
    },
    5 * PROMPT_TIMEOUT_MS,
  );

  it(
    'delivers schema-validated structured output for a reviewer-style prompt',
    async () => {
      const handleRef = handle!;
      const dir = encodeURIComponent(PROJECT_DIR);
      const auth = `Basic ${Buffer.from(`opencode:${handleRef.password}`).toString('base64')}`;
      const headers = { Authorization: auth, 'Content-Type': 'application/json' };

      // Minimal reviewer-shaped schema: a bindable verdict is the core of
      // ReviewFindings, so proving the host returns a schema-valid verdict is
      // the structured-output gate for parallel specialist reviews (#736).
      const schema = {
        type: 'object',
        properties: { verdict: { type: 'string', enum: ['accept', 'reject'] } },
        required: ['verdict'],
        additionalProperties: false,
      };

      const parent = await fetch(`${handleRef.baseUrl}/session?directory=${dir}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'FlowGuard Structured Probe Parent' }),
      });
      const parentId = ((await parent.json()) as { id: string }).id;
      const child = await fetch(`${handleRef.baseUrl}/session?directory=${dir}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ parentID: parentId, title: 'structured-child' }),
      });
      const childId = ((await child.json()) as { id: string }).id;

      const res = await fetch(`${handleRef.baseUrl}/session/${childId}/message?directory=${dir}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          parts: [{ type: 'text', text: 'Return a verdict of accept.' }],
          model: { providerID: STRUCTURED_PROVIDER_ID, modelID: STRUCTURED_MODEL_ID },
          format: { type: 'json_schema', schema, retryCount: 1 },
        }),
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as {
        parts?: Array<{
          type?: string;
          tool?: string;
          state?: { status?: string; input?: unknown; metadata?: { valid?: unknown } };
        }>;
      };

      // Live counter-check of the production extractor: the real host delivers
      // structured output as a `StructuredOutput` tool part, and
      // extractStructuredOutputToolPart must recover the schema-conformant object
      // from it (there is no info.structured_output field on this host version).
      const extracted = extractStructuredOutputToolPart(body.parts);
      console.log(
        '[structured-output-evidence]',
        JSON.stringify({ parts: body.parts, extracted }, null, 2),
      );

      expect(extracted).not.toBeNull();
      expect((extracted as { verdict?: string }).verdict).toBe('accept');
    },
    2 * PROMPT_TIMEOUT_MS,
  );
});
