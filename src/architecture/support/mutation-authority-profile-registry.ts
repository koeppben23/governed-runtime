import { readFileSync } from 'node:fs';

import type { MutationProfile, MutationProfileDefinition } from './mutation-authority-inventory.js';

interface ProfileRegistry {
  readonly version: number;
  readonly profiles: Readonly<
    Record<string, { readonly configFile: string; readonly vitestConfigFile: string }>
  >;
}

const PROFILE_REGISTRY = JSON.parse(
  readFileSync(
    new URL('../../../scripts/mutation-profile-registry.json', import.meta.url),
    'utf-8',
  ),
) as ProfileRegistry;

export const MUTATION_PROFILES = Object.fromEntries(
  Object.entries(PROFILE_REGISTRY.profiles).map(([profile, entry]) => [
    profile,
    { configFile: entry.configFile, vitestConfigFile: entry.vitestConfigFile },
  ]),
) as Readonly<Record<MutationProfile, MutationProfileDefinition>>;
