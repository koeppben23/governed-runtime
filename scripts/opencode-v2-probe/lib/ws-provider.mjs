import { WebSocketServer } from 'ws';

const EVENTS = (id, text) => [
  { type: 'response.created', response: { id } },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: 'msg_ws_probe', role: 'assistant', content: [] },
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_ws_probe',
    output_index: 0,
    content_index: 0,
    delta: text,
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'message',
      id: 'msg_ws_probe',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  },
  { type: 'response.completed', response: { id, output: [] } },
];

/**
 * Minimal local Open Responses WebSocket provider. It records every frame before
 * answering a `response.create` with a deterministic text completion.
 */
export async function startWebSocketProvider({ text = 'ws-probe-ok' } = {}) {
  const frames = [];
  const sockets = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      const frame = data.toString();
      frames.push(frame);
      let parsed;
      try {
        parsed = JSON.parse(frame);
      } catch {
        return;
      }
      if (parsed?.type !== 'response.create') return;
      const id = `resp_ws_probe_${frames.length}`;
      for (const event of EVENTS(id, text)) socket.send(JSON.stringify(event));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WebSocket provider has no address');
  return {
    port: address.port,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    frames,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.close();
        server.close(() => resolve());
      }),
  };
}
