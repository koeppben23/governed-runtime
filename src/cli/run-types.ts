import type { HostId } from '../shared/hosts.js';

export interface RunResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface HeadlessConfig {
  prompt: string;
  host?: HostId;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ServeConfig {
  host?: HostId;
  port?: number;
  hostname?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ServeResult {
  success: boolean;
  port: number;
  pid?: number;
  error?: string;
}
