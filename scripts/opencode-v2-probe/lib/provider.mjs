import { createServer } from 'node:http';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function completion(body, result, index) {
  const model = String(body?.model ?? 'probe');
  const finish = result.finish ?? (result.tool ? 'tool_calls' : 'stop');
  const usage = {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  };
  const message = {
    role: 'assistant',
    content: result.text ?? null,
  };
  if (result.tool) {
    message.tool_calls = [
      {
        id: `call_probe_${index}`,
        type: 'function',
        function: {
          name: result.tool.name,
          arguments:
            typeof result.tool.arguments === 'string'
              ? result.tool.arguments
              : JSON.stringify(result.tool.arguments ?? {}),
        },
      },
    ];
  }
  return {
    id: `chatcmpl_probe_${index}`,
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

function writeSse(res, body, result, index) {
  const model = String(body?.model ?? 'probe');
  const finish = result.finish ?? (result.tool ? 'tool_calls' : 'stop');
  const base = {
    id: `chatcmpl_probe_${index}`,
    object: 'chat.completion.chunk',
    created: 1,
    model,
  };
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const delta = result.tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_probe_${index}`,
            type: 'function',
            function: {
              name: result.tool.name,
              arguments:
                typeof result.tool.arguments === 'string'
                  ? result.tool.arguments
                  : JSON.stringify(result.tool.arguments ?? {}),
            },
          },
        ],
      }
    : { role: 'assistant', content: result.text ?? '' };
  chunk({
    ...base,
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  chunk({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
  });
  chunk({
    ...base,
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  res.end('data: [DONE]\n\n');
}

/**
 * Deterministic OpenAI-compatible capture provider.
 *
 * `script(body, index)` decides the response. Every request body is retained
 * so tests can compare the final wire request with the configured variant.
 */
export async function startProvider(script = () => ({ text: 'probe-ok' })) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && /\/models$/.test(req.url ?? '')) {
        json(res, 200, {
          object: 'list',
          data: [{ id: 'probe', object: 'model', owned_by: 'flowguard-probe' }],
        });
        return;
      }
      const isChat = /\/chat\/completions$/.test(req.url ?? '');
      const isResponses = /\/responses$/.test(req.url ?? '');
      if (req.method !== 'POST' || (!isChat && !isResponses)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length === 0 ? {} : JSON.parse(raw);
      const index = requests.length;
      requests.push({ body, headers: req.headers, url: req.url, at: new Date().toISOString() });
      const result = (await script(body, index, { headers: req.headers, url: req.url })) ?? {
        text: 'probe-ok',
      };
      if (typeof result.raw === 'string') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.end(result.raw);
      } else if (body.stream === true) writeSse(res, body, result, index);
      else json(res, 200, completion(body, result, index));
    } catch (error) {
      requests.push({ error: String(error), at: new Date().toISOString() });
      json(res, 500, { error: { message: String(error) } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider has no address');
  return {
    port: address.port,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
