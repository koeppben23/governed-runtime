/**
 * @module discovery/collectors/languages/rust
 * @description rust ecosystem detection — extracted from stack-detection.ts.
 * @version v1
 */

import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection-utils.js';
import { captureGroup, findItem, safeRead, setVersion, enrichOrCreateItem, setCompilerTarget } from '../stack-detection-utils.js';
import { collectRootBasenames } from '../stack-detection.js';

export async function extractFromRustRootFiles(
  readFile: ReadFileFn,
  allFiles: readonly string[],
  languages: DetectedItem[],
  qualityTools: DetectedItem[],
  buildTools: DetectedItem[],
): Promise<void> {
  const rootFiles = collectRootBasenames(allFiles);

  if (rootFiles.has('Cargo.toml')) {
    const content = await safeRead(readFile, 'Cargo.toml');
    if (content) {
      const edition = captureGroup(content.match(/edition\s*=\s*['"](\d{4})['"]/));
      if (edition) {
        const rust = findItem(languages, 'rust');
        if (rust && !rust.compilerTarget) {
          setCompilerTarget(rust, edition, 'Cargo.toml:edition');
        }
      }
    }
  }

  if (rootFiles.has('rust-toolchain.toml')) {
    const content = await safeRead(readFile, 'rust-toolchain.toml');
    if (content) {
      const rustVersion = captureGroup(content.match(/channel\s*=\s*['"](\d+(?:\.\d+){1,2})['"]/));
      if (rustVersion) {
        const rust = findItem(languages, 'rust');
        if (rust && !rust.version) {
          setVersion(rust, rustVersion, 'rust-toolchain.toml:channel');
        }
      }

      const components = captureGroup(content.match(/components\s*=\s*\[([^\]]+)\]/s));
      if (components?.match(/['"]clippy['"]/)) {
        enrichOrCreateItem(qualityTools, 'clippy', 'rust-toolchain.toml:components.clippy');
      }
      if (components?.match(/['"]rustfmt['"]/)) {
        enrichOrCreateItem(qualityTools, 'rustfmt', 'rust-toolchain.toml:components.rustfmt');
      }
    }
  }

  if (rootFiles.has('rust-toolchain')) {
    const content = await safeRead(readFile, 'rust-toolchain');
    if (content) {
      const firstLine = content
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith('#'));
      const rustVersion = captureGroup(firstLine?.match(/^(\d+(?:\.\d+){1,2})/) ?? null);
      if (rustVersion) {
        const rust = findItem(languages, 'rust');
        if (rust && !rust.version) {
          setVersion(rust, rustVersion, 'rust-toolchain');
        }
      }
    }
  }

  // Keep cargo root-first: if Cargo.toml does not exist at root, cargo must be absent.
  if (!rootFiles.has('Cargo.toml')) {
    const cargoIndex = buildTools.findIndex((item) => item.id === 'cargo');
    if (cargoIndex !== -1) buildTools.splice(cargoIndex, 1);
  }
}
