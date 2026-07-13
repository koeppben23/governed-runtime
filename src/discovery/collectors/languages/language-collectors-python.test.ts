import { describe, it, expect } from 'vitest';
import type { DetectedItem } from '../../types.js';
import { extractFromPythonRootFiles } from './python.js';

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

describe('languages/python', () => {
  describe('HAPPY', () => {
    it('detects pytest from requirements.txt', async () => {
      const testFrameworks: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({ 'requirements.txt': 'pytest>=7.0\n' }),
        ['requirements.txt'],
        [],
        testFrameworks,
        [],
        [],
      );
      expect(testFrameworks.find((t) => t.id === 'pytest')).toBeDefined();
    });

    it('detects python version from .python-version', async () => {
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({ '.python-version': '3.12.2\n' }),
        ['.python-version'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0]!.version).toBe('3.12.2');
    });
  });

  describe('EDGE', () => {
    it('detects python version with python- prefix in .python-version', async () => {
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({ '.python-version': 'python-3.11.9\n' }),
        ['.python-version'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0]!.version).toBe('3.11.9');
    });

    it('handles .python-version with trailing whitespace', async () => {
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({ '.python-version': '3.10.8  \n' }),
        ['.python-version'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0]!.version).toBe('3.10.8');
    });

    it('does nothing when .python-version has no recognizable version', async () => {
      // Covers line 35: version match returns null (non-numeric content)
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({ '.python-version': 'system\n' }),
        ['.python-version'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0]!.version).toBeUndefined();
    });

    it('detects black as quality tool from requirements.txt', async () => {
      const qualityTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({ 'requirements.txt': 'black>=23.0' }),
        ['requirements.txt'],
        [],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools.find((t) => t.id === 'black')).toBeDefined();
    });

    it('detects ruff from pyproject.toml', async () => {
      const qualityTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({
          'pyproject.toml': '[tool.ruff]\nline-length = 100\n',
        }),
        ['pyproject.toml'],
        [],
        [],
        qualityTools,
        [],
      );
      expect(qualityTools.find((t) => t.id === 'ruff')).toBeDefined();
    });

    it('detects python version from pyproject.toml requires-python', async () => {
      const languages: DetectedItem[] = [makeItem('python')];
      await extractFromPythonRootFiles(
        mockReadFile({
          'pyproject.toml': '[project]\nrequires-python = ">=3.9"\n',
        }),
        ['pyproject.toml'],
        languages,
        [],
        [],
        [],
      );
      expect(languages[0]!.version).toBe('3.9');
    });

    it('skips non-root files for detection', async () => {
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['subdir/requirements.txt'],
        [],
        [],
        [],
        buildTools,
      );
      expect(buildTools).toHaveLength(0);
    });
  });

  describe('pyproject.toml poetry detection', () => {
    it('detects poetry from pyproject.toml', async () => {
      // Covers line 79: pyproject.toml poetry detection
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({
          'pyproject.toml': '[tool.poetry]\nname = "test"\n',
        }),
        ['pyproject.toml'],
        [],
        [],
        [],
        buildTools,
      );
      const poetry = buildTools.find((t) => t.id === 'poetry');
      expect(poetry).toBeDefined();
      expect(poetry?.evidence).toContain('pyproject.toml:[tool.poetry]');
    });

    it('does not detect poetry when pyproject.toml has no poetry section', async () => {
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({
          'pyproject.toml': '[project]\nname = "test"\n',
        }),
        ['pyproject.toml'],
        [],
        [],
        [],
        buildTools,
      );
      const poetry = buildTools.find((t) => t.id === 'poetry');
      expect(poetry).toBeUndefined();
    });

    it('does nothing when pyproject.toml content is null', async () => {
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['pyproject.toml'],
        [],
        [],
        [],
        buildTools,
      );
      expect(buildTools).toHaveLength(0);
    });

    it('does nothing when requirements.txt content is null', async () => {
      const testFrameworks: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['requirements.txt'],
        [],
        testFrameworks,
        [],
        [],
      );
      expect(testFrameworks).toHaveLength(0);
    });

    it('does nothing when pyproject.toml content is null', async () => {
      // Covers line 43: content null check
      const buildTools: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['pyproject.toml'],
        [],
        [],
        [],
        buildTools,
      );
      expect(buildTools).toHaveLength(0);
    });

    it('does nothing when requirements.txt content is null', async () => {
      // Covers line 67: content null check
      const testFrameworks: DetectedItem[] = [];
      await extractFromPythonRootFiles(
        mockReadFile({}),
        ['requirements.txt'],
        [],
        testFrameworks,
        [],
        [],
      );
      expect(testFrameworks).toHaveLength(0);
    });
  });
});
