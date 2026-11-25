/** Read the installed product's canonical phase transition authority. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DemoNotVerifiedError } from './results.mjs';

export function canonicalTransitionResolver(resolveTransition) {
  if (typeof resolveTransition !== 'function') {
    throw new DemoNotVerifiedError('installed product transition authority is unavailable');
  }
  return (phase, event) => resolveTransition(phase, event);
}

export async function loadInstalledTransitionResolver(workspace) {
  const file = path.join(
    workspace,
    '.opencode',
    'node_modules',
    '@flowguard',
    'core',
    'dist',
    'machine',
    'topology.js',
  );
  let topology;
  try {
    topology = await import(pathToFileURL(file).href);
  } catch {
    throw new DemoNotVerifiedError('installed product transition authority is unreadable');
  }
  return canonicalTransitionResolver(topology.resolveTransition);
}
