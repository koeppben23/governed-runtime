/**
 * @module cli/run-args
 * @description Argument parsing for flowguard run and serve.
 */

import { isHostId } from '../shared/hosts.js';
import type { HeadlessConfig, ServeConfig } from './run-types.js';
import type { CliParseResult } from './parse-result.js';

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
): { index: number; done: boolean; help?: boolean } {
  const arg = argv[index];
  if (arg === '--help' || arg === '-h') {
    return { index: argv.length, done: true, help: true };
  }

  if (arg === '--') {
    const remaining = argv.slice(index + 1).join(' ');
    if (remaining) config.prompt = remaining;
    return { index: argv.length, done: true };
  }

  const handler = arg ? RUN_HANDLERS[arg] : undefined;
  if (handler) return { index: handler(argv, index, config, errors), done: false };

  if (arg && !arg.startsWith('-')) {
    if (config.prompt) {
      errors.push(`Unexpected extra argument: ${arg}`);
    } else {
      config.prompt = arg;
    }
  }
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
  if (handler) return handler(argv, index, config, errors);
  if (arg && !arg.startsWith('-')) {
    errors.push(`Unexpected positional argument: ${arg}`);
  }
  return index;
}

export function parseRunArgs(argv: string[]): CliParseResult<HeadlessConfig> {
  const config: HeadlessConfig = { prompt: '' };
  const errors: string[] = [];
  const knownFlags = ['--', '--prompt', '--cwd', '--host', '--help', '-h'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (isUnknownFlag(arg, knownFlags)) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    const result = handleRunArg(argv, i, config, errors);
    if (result.help) return { kind: 'help' };
    i = result.done ? argv.length : result.index;
  }

  if (!config.prompt) {
    errors.push('Prompt is required');
  }

  if (errors.length > 0) {
    return { kind: 'error', error: errors.join('; ') };
  }

  return { kind: 'ok', value: config };
}

export function parseServeArgs(argv: string[]): CliParseResult<ServeConfig> {
  const config: ServeConfig = {};
  const errors: string[] = [];
  const knownFlags = ['--port', '--hostname', '--cwd', '--host', '--help', '-h'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') return { kind: 'help' };

    if (isUnknownFlag(arg, knownFlags)) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    i = handleServeArg(argv, i, config, errors);
  }

  if (errors.length > 0) {
    return { kind: 'error', error: errors.join('; ') };
  }

  return { kind: 'ok', value: config };
}
