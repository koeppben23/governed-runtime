/** MCP tool execution limits, scoped to one server instance. */

export interface McpExecutionLimits {
  readonly timeoutMs: number;
  readonly maxConcurrent: number;
  readonly maxPerSecond: number;
}

export const DEFAULT_MCP_EXECUTION_LIMITS: McpExecutionLimits = {
  timeoutMs: 30_000,
  maxConcurrent: 10,
  maxPerSecond: 50,
};

export function readMcpExecutionLimits(env = process.env): McpExecutionLimits {
  return {
    timeoutMs: readPositiveInteger(
      env['FLOWGUARD_MCP_TOOL_TIMEOUT_MS'],
      'FLOWGUARD_MCP_TOOL_TIMEOUT_MS',
      30_000,
    ),
    maxConcurrent: readPositiveInteger(
      env['FLOWGUARD_MCP_MAX_CONCURRENT'],
      'FLOWGUARD_MCP_MAX_CONCURRENT',
      10,
    ),
    maxPerSecond: readPositiveInteger(
      env['FLOWGUARD_MCP_MAX_PER_SECOND'],
      'FLOWGUARD_MCP_MAX_PER_SECOND',
      50,
    ),
  };
}

function readPositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return Number(value);
}

export class McpExecutionLimiter {
  private active = 0;
  private readonly starts: number[] = [];

  constructor(readonly limits: McpExecutionLimits) {}

  tryAcquire(now = Date.now()): boolean {
    while (this.starts[0] !== undefined && this.starts[0] <= now - 1_000) this.starts.shift();
    if (
      this.active >= this.limits.maxConcurrent ||
      this.starts.length >= this.limits.maxPerSecond
    ) {
      return false;
    }
    this.active += 1;
    this.starts.push(now);
    return true;
  }

  release(): void {
    this.active -= 1;
  }
}
