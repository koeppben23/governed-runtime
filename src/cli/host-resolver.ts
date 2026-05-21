/**
 * @module cli/host-resolver
 * @description Resolve FlowGuard CLI host execution configuration.
 */

import { readConfig } from '../adapters/persistence-config.js';
import { DEFAULT_HOST, type HostId } from '../shared/hosts.js';

export interface HostResolutionInput {
  cliHost?: HostId;
  cwd?: string;
}

export interface HostResolutionResult {
  host: HostId;
  source: 'cli' | 'config' | 'default';
}

export async function resolveHost(input: HostResolutionInput = {}): Promise<HostResolutionResult> {
  if (input.cliHost) {
    return { host: input.cliHost, source: 'cli' };
  }

  const config = await readConfig(input.cwd);
  if (config.host.defaultHost) {
    return { host: config.host.defaultHost, source: 'config' };
  }

  return { host: DEFAULT_HOST, source: 'default' };
}
