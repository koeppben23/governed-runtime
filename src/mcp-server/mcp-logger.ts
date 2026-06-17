/**
 * @module mcp-server/mcp-logger
 * @description Shared MCP server logger via the canonical FlowGuard logger interface.
 *
 * Single authority for MCP server diagnostic logging. Both server.ts and
 * tool-adapter.ts import the same instance, avoiding duplicated factories
 * and import cycles.
 *
 * The MCP server runs outside the plugin ALS scope, so it cannot use
 * `getAdapterLogger()`. This logger writes to a console sink (stderr)
 * via the same `FlowGuardLogger` interface as the rest of the runtime.
 */

import { createLogger, createConsoleSink } from '../logging/index.js';

export const mcpLogger = createLogger('info', [createConsoleSink()]);
