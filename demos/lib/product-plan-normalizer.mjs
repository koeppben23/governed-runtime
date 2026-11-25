/** Read the installed product's canonical plan/ADR text identity normalizer. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DemoNotVerifiedError } from './results.mjs';

export function canonicalPlanNormalizer(normalize) {
  if (typeof normalize !== 'function') {
    throw new DemoNotVerifiedError('installed product plan normalizer is unavailable');
  }
  return (text) => normalize(text);
}

export async function loadInstalledPlanNormalizer(workspace) {
  const file = path.join(
    workspace,
    '.opencode',
    'node_modules',
    '@flowguard',
    'core',
    'dist',
    'shared',
    'review-artifact-text.js',
  );
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch {
    throw new DemoNotVerifiedError('installed product plan normalizer is unreadable');
  }
  return canonicalPlanNormalizer(module.normalizeReviewArtifactText);
}
