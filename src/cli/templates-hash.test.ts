/** Golden hashes pin installed bytes; tool completeness is owned by native setup. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  PLUGIN_WRAPPER,
  PLUGIN_RELATIVE_PATH,
  COMMANDS,
  FLOWGUARD_MANDATES_KERNEL,
  REVIEWER_AGENT,
  PACKAGE_JSON_TEMPLATE,
} from './templates.js';
import { FLOWGUARD_TOOL_NAMES, FLOWGUARD_TOOL_PREFIX } from '../integration/tool-names.js';
import * as tools from '../integration/tools/index.js';
import { INSTALLED_TEMPLATE_FILES } from '../integration/installed-commands.js';

const MANIFEST_URL = new URL('../../scripts/template-hashes.json', import.meta.url);
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function computeTemplateHashes(): Record<string, string> {
  return {
    pluginWrapper: sha256(PLUGIN_WRAPPER),
    flowguardMandatesKernel: sha256(FLOWGUARD_MANDATES_KERNEL),
    reviewerAgent: sha256(REVIEWER_AGENT),
    packageJsonTemplate: sha256(PACKAGE_JSON_TEMPLATE('1.2.3')),
    commands: sha256(JSON.stringify(COMMANDS, Object.keys(COMMANDS).sort())),
  };
}
if (process.env.TEMPLATE_HASHES_WRITE === '1') {
  writeFileSync(MANIFEST_URL, `${JSON.stringify(computeTemplateHashes(), null, 2)}\n`, 'utf8');
}
describe('TEMPLATE_HASH_STABILITY', () => {
  it('golden hash manifest matches every current template byte-for-byte', () => {
    expect(JSON.parse(readFileSync(MANIFEST_URL, 'utf8'))).toEqual(computeTemplateHashes());
  });
  it('installs exactly one native default export, not a second tool discovery surface', () => {
    expect(PLUGIN_RELATIVE_PATH).toBe('plugins/flowguard/index.ts');
    expect(PLUGIN_WRAPPER).toContain(
      'export { default } from "@flowguard/core/integration/plugin"',
    );
    expect(PLUGIN_WRAPPER).not.toMatch(/export const|export function|status,|hydrate,/);
  });
  it('retains all installed commands', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([...INSTALLED_TEMPLATE_FILES].sort());
    expect(Object.keys(COMMANDS)).toHaveLength(20);
  });
  it('every canonical native tool has exactly one application implementation', () => {
    expect(FLOWGUARD_TOOL_NAMES).toHaveLength(new Set(FLOWGUARD_TOOL_NAMES).size);
    for (const name of FLOWGUARD_TOOL_NAMES) {
      const tool = tools[name.slice(FLOWGUARD_TOOL_PREFIX.length) as keyof typeof tools];
      expect(tool, name).toHaveProperty('execute');
      expect(tool, name).toHaveProperty('args');
    }
    expect(FLOWGUARD_TOOL_NAMES).toContain('flowguard_run_check');
    expect(FLOWGUARD_TOOL_NAMES).not.toContain('flowguard_validate');
  });
});
