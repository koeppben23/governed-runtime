import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function read(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

describe('command documentation alignment', () => {
  it('keeps the README on the merged develop V2 baseline', () => {
    const readme = read('README.md');
    expect(readme).not.toContain('PR #1190 is Draft');
    expect(readme).not.toContain('installed V2 acceptance remains NOT_VERIFIED');
    expect(readme).not.toContain('open Desktop PR');
    expect(readme).toContain('V2-only port');
    expect(readme).toContain('#1207');
  });

  it('does not describe /continue as an auto-advance command', () => {
    const quickStart = read('docs/quick-start.md');
    const index = read('docs/index.md');
    expect(quickStart).not.toMatch(/\/continue\s*\|\s*Auto-advance/i);
    expect(index).not.toMatch(/\/continue\s*\|\s*Auto-advance/i);
    expect(quickStart).toContain('Read-only next-action routing');
  });

  it('does not describe /check as a validation compatibility alias', () => {
    expect(read('docs/quick-start.md')).not.toContain('Compatibility: re-run validation');
  });

  it('does not describe the merged Desktop workbench as an open PR', () => {
    expect(read('docs/quick-start.md')).not.toContain('open Desktop PR');
    expect(read('docs/commands.md')).not.toContain('open Desktop PR');
  });

  it('does not describe the merged V2 port as a Draft PR', () => {
    expect(read('docs/installation.md')).not.toContain('PR #1190 remains Draft');
  });

  it('documents native operator commands in the command reference', () => {
    const commands = read('docs/commands.md');
    expect(commands).toContain('### `/recover-capacity`');
    expect(commands).toContain('### `/end-governance`');
    expect(commands).toContain('/debug-export');
    expect(commands).toContain('/diagnostics');
    expect(commands).toContain('/choose-workflow');
  });
});
