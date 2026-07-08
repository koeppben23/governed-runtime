/**
 * @module cli/doctor-plugin
 * @description Plugin activation check for the doctor command.
 *
 * Extracted from doctor-command.ts to keep the module under the 700 LOC
 * threshold. Verifies the FlowGuard audit plugin file exists and
 * @flowguard/core is ESM-importable.
 *
 * @version v1
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck } from './install-types.js';

export async function checkPluginActivation(target: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const pluginFile = join(target, 'plugins', 'flowguard-audit.ts');

  if (!existsSync(pluginFile)) {
    checks.push({
      file: pluginFile,
      status: 'missing',
      detail: 'Plugin file not installed — run flowguard install',
    });
    return checks;
  }

  try {
    execSync(`node --input-type=module -e "import('@flowguard/core/integration/plugin')"`, {
      cwd: target,
      stdio: 'pipe',
      timeout: 10_000,
    });
    checks.push({
      file: pluginFile,
      status: 'ok',
      detail: 'Plugin package importable',
    });
  } catch {
    checks.push({
      file: pluginFile,
      status: 'error',
      detail:
        'Plugin package not importable — verify @flowguard/core is installed and dependencies are present',
    });
  }

  return checks;
}
