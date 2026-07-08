/**
 * @module discovery/collectors/languages/language-collectors-go.test
 */
import { describe, it, expect } from 'vitest';
import type { DetectedItem } from '../../types.js';
import { extractFromGoMod } from './go.js';
import { extractFromRustRootFiles } from './rust.js';

function makeItem(id: string, overrides?: Partial<DetectedItem>): DetectedItem {
  return {
    id,
    confidence: 0.9,
    classification: 'derived_signal',
    evidence: ['detected'],
    ...overrides,
  };
}

function mockReadFile(files: Record<string, string>) {
  return async (path: string) => files[path];
}

// ─── go.ts ─────────────────────────────────────────────────────────────────────

describe('languages/go', () => {
  describe('HAPPY', () => {
    it('sets go version from go.mod', async () => {
      const languages: DetectedItem[] = [makeItem('go')];
      await extractFromGoMod(mockReadFile({ 'go.mod': 'module example\n\ngo 1.23\n' }), languages, [
        'go.mod',
      ]);
      expect(languages[0].version).toBe('1.23');
      expect(languages[0].versionEvidence).toBe('go.mod:go');
    });
  });

  describe('BAD', () => {
    it('does nothing when go.mod has no version line', async () => {
      // Covers line 24: if (!goVer) return
      const languages: DetectedItem[] = [makeItem('go')];
      await extractFromGoMod(mockReadFile({ 'go.mod': 'module example\n' }), languages, ['go.mod']);
      expect(languages[0].version).toBeUndefined();
    });

    it('does not overwrite existing go version', async () => {
      // Covers line 27: goItem && !goItem.version (false path)
      const languages: DetectedItem[] = [
        makeItem('go', { version: '1.22', versionEvidence: 'prior' }),
      ];
      await extractFromGoMod(mockReadFile({ 'go.mod': 'module example\n\ngo 1.23\n' }), languages, [
        'go.mod',
      ]);
      expect(languages[0].version).toBe('1.22');
    });
  });

  describe('CORNER', () => {
    it('removes cargo when Cargo.toml is absent', async () => {
      const buildTools: DetectedItem[] = [makeItem('cargo')];
      await extractFromRustRootFiles(mockReadFile({}), ['src/main.rs'], [], [], buildTools);
      expect(buildTools.find((t) => t.id === 'cargo')).toBeUndefined();
    });

    it('keeps cargo when Cargo.toml is present', async () => {
      const buildTools: DetectedItem[] = [makeItem('cargo')];
      await extractFromRustRootFiles(
        mockReadFile({
          'Cargo.toml': '[package]\nname = "test"\n',
        }),
        ['Cargo.toml'],
        [],
        [],
        buildTools,
      );
      expect(buildTools.find((t) => t.id === 'cargo')).toBeDefined();
    });

    it('does nothing when rust-toolchain.toml has no channel', async () => {
      // Covers line 47: rust && !rust.version when channel is absent
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': '[toolchain]\n',
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].version).toBeUndefined();
    });

    it('does nothing when rust-toolchain.toml has no components block', async () => {
      // Covers line 64: components regex returns null
      const qualityTools: DetectedItem[] = [];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': '[toolchain]\nchannel = "stable"\n',
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools).toHaveLength(0);
    });

    it('skips clippy when components block does not contain clippy', async () => {
      // Covers lines 69-72: components match for clippy false, rustfmt true
      const qualityTools: DetectedItem[] = [];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': `[toolchain]
channel = "stable"
components = ["rustfmt"]
`,
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools.find((t) => t.id === 'clippy')).toBeUndefined();
      expect(qualityTools.find((t) => t.id === 'rustfmt')).toBeDefined();
    });

    it('skips rust-toolchain.toml when file is empty', async () => {
      // Covers line 43: content null branch (safeRead returns empty/undefined)
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({}),
        ['rust-toolchain.toml', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].version).toBeUndefined();
    });

    it('does not overwrite rust version when already set from toolchain', async () => {
      // Covers line 47: rust && !rust.version false path
      const languages: DetectedItem[] = [
        makeItem('rust', { version: '1.76.0', versionEvidence: 'prior' }),
      ];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': `[toolchain]
channel = "1.77.0"
`,
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0].version).toBe('1.76.0');
    });
  });
});
