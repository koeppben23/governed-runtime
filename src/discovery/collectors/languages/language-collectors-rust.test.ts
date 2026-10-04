import { describe, it, expect } from 'vitest';
import type { DetectedItem } from '../../types.js';
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

describe('languages/rust', () => {
  describe('HAPPY', () => {
    it('detects rust version from rust-toolchain.toml channel', async () => {
      // Covers line 47: channel detection
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': '[toolchain]\nchannel = "1.77.0"\n',
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0]!.version).toBe('1.77.0');
    });

    it('detects clippy and rustfmt from rust-toolchain.toml components', async () => {
      // Covers lines 53-57: components detection
      const qualityTools: DetectedItem[] = [];
      await extractFromRustRootFiles(
        mockReadFile({
          'rust-toolchain.toml': `[toolchain]
channel = "stable"
components = ["clippy", "rustfmt"]
`,
        }),
        ['rust-toolchain.toml', 'Cargo.toml'],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools.find((t) => t.id === 'clippy')).toBeDefined();
      expect(qualityTools.find((t) => t.id === 'rustfmt')).toBeDefined();
    });

    it('detects rust version from plain rust-toolchain file', async () => {
      // Covers lines 64-75: plain rust-toolchain detection
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({ 'rust-toolchain': '1.76.0\n' }),
        ['rust-toolchain', 'Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0]!.version).toBe('1.76.0');
    });
  });

  describe('CORNER', () => {
    it('detects rust edition from Cargo.toml', async () => {
      // Covers line 31-36: edition detection
      const languages: DetectedItem[] = [makeItem('rust')];
      await extractFromRustRootFiles(
        mockReadFile({
          'Cargo.toml': `[package]
name = "test"
edition = "2021"
`,
        }),
        ['Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0]!.compilerTarget).toBe('2021');
    });

    it('does not overwrite existing rust edition', async () => {
      const languages: DetectedItem[] = [
        makeItem('rust', { compilerTarget: '2018', compilerTargetEvidence: 'prior' }),
      ];
      await extractFromRustRootFiles(
        mockReadFile({
          'Cargo.toml': `[package]
name = "test"
edition = "2021"
`,
        }),
        ['Cargo.toml'],
        languages,
        [],
        [],
      );
      expect(languages[0]!.compilerTarget).toBe('2018');
    });

    it('removes cargo when Cargo.toml is absent', async () => {
      // Covers line 82: cargo removal
      const buildTools: DetectedItem[] = [makeItem('cargo')];
      await extractFromRustRootFiles(mockReadFile({}), ['src/main.rs'], [], [], buildTools);
      expect(buildTools.find((t) => t.id === 'cargo')).toBeUndefined();
    });

    it('keeps cargo when Cargo.toml is present', async () => {
      // Covers the happy branch of !rootFiles.has('Cargo.toml')
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
  });
});
