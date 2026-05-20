/**
 * @module mcp-server/stdout-guard
 * @description Defense-in-depth guard that prevents accidental stdout contamination
 * in the MCP stdio transport.
 *
 * Problem: MCP stdio reserves stdout exclusively for JSON-RPC messages. Any stray
 * console.log, process.stdout.write, or third-party library output would corrupt
 * the protocol framing. The host would either drop the message or mark the server
 * as unhealthy.
 *
 * Solution: Intercept process.stdout.write and redirect non-JSON-RPC writes to stderr.
 * This is a "redirect" strategy (not "throw") - safer with third-party deps that
 * might write diagnostics.
 *
 * This guard should be installed FIRST in the entry point, before any other imports
 * can accidentally write to stdout.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/243#issuecomment-4485775788
 */

let installed = false;

/**
 * Install the stdout guard.
 * After this call, any write to process.stdout that is not a valid JSON-RPC message
 * will be silently redirected to process.stderr.
 *
 * Idempotent - calling multiple times is safe.
 */
export function installStdoutGuard(): void {
  if (installed) return;
  installed = true;

  const originalWrite = process.stdout.write.bind(process.stdout);

  // Overwrite stdout.write with a filtering proxy.
  // Use the two-arg overload signature (chunk, encoding?) for simplicity.
  const guardedWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);

    // JSON-RPC messages are JSON objects starting with '{' (after optional whitespace)
    // and containing "jsonrpc" field. Allow these through.
    if (isJsonRpcMessage(text)) {
      if (typeof encodingOrCallback === 'function') {
        return originalWrite(chunk, encodingOrCallback);
      }
      return originalWrite(chunk, encodingOrCallback, callback);
    }

    // Redirect non-JSON-RPC writes to stderr (silent, non-blocking)
    if (typeof encodingOrCallback === 'function') {
      return process.stderr.write(chunk, encodingOrCallback);
    }
    return process.stderr.write(chunk, encodingOrCallback, callback);
  };
  process.stdout.write = guardedWrite as typeof process.stdout.write;
}

/**
 * Check if a string looks like a valid JSON-RPC message.
 * We use a lightweight heuristic - not full JSON parsing - for performance.
 */
function isJsonRpcMessage(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return false;
  // Quick check for jsonrpc field presence (handles both "jsonrpc":"2.0" variants)
  return trimmed.includes('"jsonrpc"');
}
