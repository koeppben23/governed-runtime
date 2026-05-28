/**
 * @module hooks/shared/stdout-guard
 * @description Intercepts process.stdout.write at hook entry to prevent
 * transitive dependency output from corrupting the hook's JSON response.
 *
 * Command hooks communicate with the host via stdout JSON:
 * - ALLOW = exit 0 with empty stdout
 * - DENY  = JSON payload on stdout
 *
 * If any imported module (debug logging, console.log in a dep) writes to stdout,
 * it corrupts this protocol. This guard captures all stdout writes until the hook
 * explicitly releases with writeResponse() or restore().
 *
 * Usage:
 *   const guard = installHookStdoutGuard();
 *   // ... hook logic ...
 *   await guard.writeResponse(jsonPayload); // DENY path
 *   // OR
 *   guard.restore(); // ALLOW path (empty stdout)
 *
 * @version v1
 */

export interface HookStdoutGuard {
  /** Write the hook's response to stdout and restore original write. */
  writeResponse(payload: string): Promise<void>;
  /** Restore original stdout without writing (ALLOW path). */
  restore(): void;
}

/**
 * Install the hook stdout guard.
 *
 * Monkey-patches process.stdout.write to buffer all spurious output.
 * Must be called synchronously at hook entry before any async imports resolve.
 *
 * Spurious output is redirected to stderr with a warning prefix for debugging.
 */
export function installHookStdoutGuard(): HookStdoutGuard {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const spuriousChunks: Buffer[] = [];

  // Intercept all stdout writes
  const guardedWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    // Buffer the spurious output
    const buf =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')
        : Buffer.from(chunk);
    spuriousChunks.push(buf);

    // Call callback immediately to prevent backpressure hangs
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (cb) cb(null);
    return true;
  };

  process.stdout.write = guardedWrite as typeof process.stdout.write;

  function restoreOriginal(): void {
    process.stdout.write = originalWrite;
    if (spuriousChunks.length > 0) {
      const spurious = Buffer.concat(spuriousChunks).toString('utf8');
      try {
        process.stderr.write(
          `[FlowGuard Hook] WARNING: captured spurious stdout (${spurious.length} bytes): ${spurious.slice(0, 200)}\n`,
        );
      } catch {
        // stderr may also be broken — nothing left to do
      }
    }
  }

  return {
    async writeResponse(payload: string): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error | null): void => {
          if (settled) return;
          settled = true;
          restoreOriginal();
          if (err) reject(err);
          else resolve();
        };

        try {
          // Write via originalWrite (captured at install time) to bypass the
          // guard for the DENY payload. The callback is the sole delivery/error
          // authority — even when write() returns false (backpressure), the
          // callback fires on completion or failure. No resolution on 'drain'.
          originalWrite(payload, (err?: Error | null) => finish(err));
        } catch (err) {
          if (!settled) {
            settled = true;
            restoreOriginal();
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    restore(): void {
      restoreOriginal();
    },
  };
}
