#!/usr/bin/env node
/**
 * Test-only forwarding proxy for the reviewer GUI acceptance.
 *
 * It forwards provider requests unchanged and writes one JSONL line per
 * request containing only correlation and output-cap metadata. Prompt text,
 * messages, tool arguments, headers, and credentials are never logged.
 *
 * Usage:
 *   node demos/reviewer-reference-suite/capture-provider-proxy.mjs \
 *     --port 8787 --upstream https://api.deepseek.com --log /tmp/provider-cap.jsonl
 *
 * Point the OpenCode provider baseURL at http://127.0.0.1:8787/v1 for the
 * acceptance run, then correlate the logged request with the FlowGuard
 * reviewer log by timestamp/session.
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DEFAULT_UPSTREAM = 'https://api.deepseek.com';

function parseArgs(argv) {
  const options = { port: 8787, upstream: DEFAULT_UPSTREAM, log: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (flag === '--port') options.port = Number(next());
    else if (flag === '--upstream') options.upstream = next();
    else if (flag === '--log') options.log = next();
    else if (flag === '--help') {
      console.log('usage: capture-provider-proxy.mjs --port <port> --upstream <url> --log <jsonl>');
      process.exit(0);
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be a valid TCP port');
  }
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    throw new Error('--upstream must be http(s)');
  }
  if (!options.log) throw new Error('--log <jsonl> is required');
  return { ...options, upstream };
}

function allowedFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { parse: 'not-an-object' };
  }
  return {
    model: typeof body.model === 'string' ? body.model : null,
    maxTokens:
      typeof body.max_tokens === 'number'
        ? body.max_tokens
        : typeof body.max_output_tokens === 'number'
          ? body.max_output_tokens
          : null,
    stream: body.stream === true,
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = createWriteStream(options.log, { flags: 'a', encoding: 'utf8' });

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const target = new URL(request.url ?? '/', options.upstream);
    const raw = await readBody(request);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      body = null;
    }
    const fields = allowedFields(body);
    log.write(
      `${JSON.stringify({
        kind: 'request',
        at: new Date().toISOString(),
        requestId,
        method: request.method,
        path: target.pathname,
        ...fields,
      })}\n`,
    );

    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = { ...request.headers };
    delete headers.host;
    headers['content-length'] = String(raw.length);
    const upstreamRequest = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        upstreamResponse.on('end', () => {
          log.write(
            `${JSON.stringify({
              kind: 'response',
              at: new Date().toISOString(),
              requestId,
              status: upstreamResponse.statusCode ?? null,
              durationMs: Date.now() - startedAt,
            })}\n`,
          );
        });
      },
    );
    upstreamRequest.on('error', (error) => {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'proxy_upstream_error' }));
      log.write(
        `${JSON.stringify({
          kind: 'error',
          at: new Date().toISOString(),
          requestId,
          durationMs: Date.now() - startedAt,
          code: error.code ?? 'PROXY_ERROR',
        })}\n`,
      );
    });
    upstreamRequest.end(raw);
  });

  server.listen(options.port, '127.0.0.1', () => {
    console.log(
      `capture proxy listening on http://127.0.0.1:${options.port} -> ${options.upstream}; ` +
        `metadata log: ${options.log}`,
    );
  });
  const shutdown = () => {
    server.close(() => {
      log.end();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main();
