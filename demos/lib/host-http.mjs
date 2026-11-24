/** Direct loopback transport. No redirect, proxy, disk credentials or response text. */
import { createHash } from 'node:crypto';
import http from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;

export class HostTransportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function requestLoopback(
  port,
  route,
  { method, headers = {}, body = undefined },
  timeoutMs,
) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !route.startsWith('/api/')) {
    throw new HostTransportError('HOST_HTTP_ENDPOINT_INVALID', 'invalid isolated host endpoint');
  }
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const failed = () => {
      clearTimeout(timer);
      reject(
        new HostTransportError('HOST_HTTP_INCOMPLETE', 'isolated host response did not complete'),
      );
    };
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        headers,
        agent: false,
        signal: controller.signal,
      },
      (response) => {
        const hash = createHash('sha256');
        let bodyLength = 0;
        response.on('error', failed);
        response.on('data', (chunk) => {
          bodyLength += chunk.length;
          if (bodyLength > MAX_BODY_BYTES) {
            controller.abort();
            return;
          }
          hash.update(chunk);
        });
        response.on('end', () => {
          clearTimeout(timer);
          if (!response.complete || controller.signal.aborted) return failed();
          resolve({ status: response.statusCode, bodyLength, bodySha256: hash.digest('hex') });
        });
      },
    );
    request.on('error', failed);
    request.end(body);
  });
}
