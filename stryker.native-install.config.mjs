/** Bounded installer mutation run; inherit the repository's unchanged gates. */
import { readFileSync } from 'node:fs';

const base = JSON.parse(readFileSync(new URL('./stryker.conf.json', import.meta.url), 'utf8'));
export default {
  ...base,
  mutate: ['src/cli/install-ownership.ts', 'src/cli/install-helpers.ts'],
  vitest: { ...base.vitest, configFile: 'vitest.stryker-native-install.config.ts' },
  jsonReporter: { fileName: 'reports/mutation/native-install/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/native-install/mutation.html' },
};
