/**
 * @module cli/run-args
 * @description Argument parsing for flowguard run and serve.
 */

import { isHostId } from '../shared/hosts.js';
import type { HeadlessConfig, ServeConfig } from './run.js';

function isUnknownFlag(arg: string, knownFlags: string[]): boolean {
  return arg.startsWith('-') && !knownFlags.includes(arg);
}

function readFlagValue(
  argv: string[],
  index: number,
  flag: string,
  errors: string[],
): string | null {
  const next = argv[index + 1];
  if (next) return next;
  errors.push(`${flag} requires a value`);
  return null;
}

function applyHost(
  config: { host?: HeadlessConfig['host'] },
  value: string,
  errors: string[],
): boolean {
  if (isHostId(value)) {
    config.host = value;
    return true;
  }
  errors.push(`Invalid host: ${value}`);
  return false;
}

function applyPort(config: ServeConfig, value: string, errors: string[]): boolean {
  const port = parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    errors.push('--port must be 1-65535');
    return false;
  }
  config.port = port;
  return true;
}

type RunHandler = (
  argv: string[],
  index: number,
  config: HeadlessConfig,
  errors: string[],
) => number;

type ServeHandler = (
  argv: string[],
  index: number,
  config: ServeConfig,
  errors: string[],
) => number;

const RUN_HANDLERS: Record<string, RunHandler> = {
  '--prompt': (argv, index, config, errors) => {
    const next = readFlagValue(argv, index, '--prompt', errors);
    if (next) config.prompt = next;
    return next ? index + 1 : index;
  },
  '--cwd': (argv, index, config, errors) => {
    const next = readFlagValue(argv, index, '--cwd', errors);
    if (next) config.cwd = next;
    return next ? index + 1 : index;
  },
  '--host': (argv, index, config, errors) => {
    const next = readFlagValue(argv, index, '--host', errors);
    return next && applyHost(config, next, errors) ? index + 1 : index;
  },
};

const SERVE_HANDLERS: Record<string, ServeHandler> = {
  '--port': (argv, index, config, errors) => {
    const next = readFlagValue(argv, index, '--port', errors);
    return next && applyPort(config, next, errors) ? index + 1 : index;
  },
  '--hostname': (argv, index, config, errors) => {
    const next = readFlagValue(argv, index, '--hostname', errors);
    if (next) config.hostname = next;
    return next ? index + 1 : index;
  },
  '--cwd': (argv, index, config, errors) => {
    const next = readFlagValue(argv, index, '--cwd', errors);
    if (next) config.cwd = next;
    return next ? index + 1 : index;
  },
  '--host': (argv, index, config, errors) => {
    const next = readFlagValue(argv, index, '--host', errors);
    return next && applyHost(config, next, errors) ? index + 1 : index;
  },
};

function handleRunArg(
  argv: string[],
  index: number,
  config: HeadlessConfig,
  errors: string[],
): { index: number; done: boolean } {
  const arg = argv[index];
  if (arg === '--') {
    const next = argv[index + 1];
    if (next) config.prompt = next;
    return { index, done: true };
  }
  const handler = arg ? RUN_HANDLERS[arg] : undefined;
  if (handler) return { index: handler(argv, index, config, errors), done: false };
  if (arg && !arg.startsWith('-')) config.prompt = arg;
  return { index, done: false };
}

function handleServeArg(
  argv: string[],
  index: number,
  config: ServeConfig,
  errors: string[],
): number {
  const arg = argv[index];
  const handler = arg ? SERVE_HANDLERS[arg] : undefined;
  return handler ? handler(argv, index, config, errors) : index;
}

export function parseRunArgs(argv: string[]): { config: HeadlessConfig; errors: string[] } | null {
  const config: HeadlessConfig = { prompt: '' };
  const errors: string[] = [];
  const knownFlags = ['--', '--prompt', '--cwd', '--host'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (isUnknownFlag(arg, knownFlags)) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    const result = handleRunArg(argv, i, config, errors);
    i = result.done ? argv.length : result.index;
  }

  if (!config.prompt) {
    errors.push('Prompt is required');
  }

  return errors.length > 0 ? null : { config, errors };
}

export function parseServeArgs(argv: string[]): { config: ServeConfig; errors: string[] } | null {
  const config: ServeConfig = {};
  const errors: string[] = [];
  const knownFlags = ['--port', '--hostname', '--cwd', '--host'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (isUnknownFlag(arg, knownFlags)) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    i = handleServeArg(argv, i, config, errors);
  }

  return errors.length > 0 ? null : { config, errors };
}
