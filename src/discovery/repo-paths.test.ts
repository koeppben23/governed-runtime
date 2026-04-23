import { describe, expect, it } from 'vitest';

import { getRootBasename, isRootLevelRepoSignal, normalizeRepoSignalPath } from './repo-paths.js';

describe('discovery/repo-paths', () => {
  describe('HAPPY', () => {
    it('normalizes repo-relative root paths across separators and dot-prefixes', () => {
      expect(normalizeRepoSignalPath('docker-compose.yml')).toBe('docker-compose.yml');
      expect(normalizeRepoSignalPath('./docker-compose.yml')).toBe('docker-compose.yml');
      expect(normalizeRepoSignalPath('.\\docker-compose.yml')).toBe('docker-compose.yml');
      expect(normalizeRepoSignalPath('././pnpm-lock.yaml')).toBe('pnpm-lock.yaml');
    });

    it('identifies root-level repo signal paths', () => {
      expect(isRootLevelRepoSignal('docker-compose.yml')).toBe(true);
      expect(isRootLevelRepoSignal('./docker-compose.yml')).toBe(true);
      expect(isRootLevelRepoSignal('.\\docker-compose.yml')).toBe(true);
      expect(isRootLevelRepoSignal('././pnpm-lock.yaml')).toBe(true);
    });

    it('returns root basename only for root-level paths', () => {
      expect(getRootBasename('docker-compose.yml')).toBe('docker-compose.yml');
      expect(getRootBasename('./docker-compose.yml')).toBe('docker-compose.yml');
      expect(getRootBasename('.\\docker-compose.yml')).toBe('docker-compose.yml');
    });
  });

  describe('BAD', () => {
    it('rejects nested paths for root-level checks', () => {
      expect(isRootLevelRepoSignal('packages/app/docker-compose.yml')).toBe(false);
      expect(isRootLevelRepoSignal('packages\\app\\pnpm-lock.yaml')).toBe(false);
      expect(getRootBasename('packages/app/docker-compose.yml')).toBeNull();
      expect(getRootBasename('packages\\app\\pnpm-lock.yaml')).toBeNull();
    });

    it('rejects absolute paths', () => {
      expect(isRootLevelRepoSignal('/absolute/path/file')).toBe(false);
      expect(isRootLevelRepoSignal('C:\\repo\\file')).toBe(false);
      expect(getRootBasename('/absolute/path/file')).toBeNull();
      expect(getRootBasename('C:\\repo\\file')).toBeNull();
    });
  });

  describe('CORNER', () => {
    it('rejects empty and degenerate values', () => {
      for (const value of ['', ' ', '/', './']) {
        expect(isRootLevelRepoSignal(value)).toBe(false);
        expect(getRootBasename(value)).toBeNull();
      }
    });

    it('normalizes repeated separators and still rejects nested paths', () => {
      expect(normalizeRepoSignalPath('packages////app\\\\docker-compose.yml')).toBe(
        'packages/app/docker-compose.yml',
      );
      expect(isRootLevelRepoSignal('packages////app\\\\docker-compose.yml')).toBe(false);
    });
  });

  describe('SMOKE/PERF', () => {
    it('evaluates 10k repo-signal path checks quickly', () => {
      const paths = Array.from({ length: 10_000 }, (_, i) => `packages/p${i}/docker-compose.yml`);
      const start = performance.now();
      let rootCount = 0;
      for (const filePath of paths) {
        if (isRootLevelRepoSignal(filePath)) rootCount++;
      }
      const elapsedMs = performance.now() - start;

      expect(rootCount).toBe(0);
      expect(elapsedMs).toBeLessThan(250);
    });
  });
});
