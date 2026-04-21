/**
 * @module discovery/scoped-stack.test
 * @description Unit tests for module-scoped stack detection.
 */

import { describe, it, expect } from 'vitest';
import type { DetectedItem } from './types';
import { extractScopedStack } from './scoped-stack';

describe('discovery/scoped-stack', () => {
  // ─── HAPPY: basic scope detection ──────
  describe('HAPPY', () => {
    it('detects apps/web scope from nested package.json', async () => {
      const allFiles = [
        'apps/web/package.json',
        'apps/web/vitest.config.ts',
        'apps/web/src/index.tsx',
      ];
      const stackInfo = {
        languages: [
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['apps/web/package.json:dependencies.typescript'],
          },
        ] as DetectedItem[],
        frameworks: [
          {
            id: 'react',
            confidence: 0.85,
            classification: 'derived_signal' as const,
            evidence: ['apps/web/package.json:dependencies.react'],
          },
        ] as DetectedItem[],
        buildTools: [
          {
            id: 'pnpm',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['apps/web/pnpm-lock.yaml'],
          },
        ] as DetectedItem[],
        testFrameworks: [
          {
            id: 'vitest',
            confidence: 0.85,
            classification: 'derived_signal' as const,
            evidence: ['apps/web/vitest.config.ts'],
          },
        ] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('apps/web');
      expect(result[0]!.items.map((i) => i.id)).toContain('react');
      expect(result[0]!.items.map((i) => i.id)).toContain('vitest');
    });

    it('detects multiple scopes from monorepo structure', async () => {
      const allFiles = [
        'apps/web/package.json',
        'apps/api/package.json',
        'packages/shared/package.json',
        'packages/shared/src/index.ts',
      ];
      const stackInfo = {
        languages: [
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['apps/web/package.json'],
          },
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['apps/api/package.json'],
          },
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['packages/shared/package.json'],
          },
        ] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(3);
      expect(result.map((s) => s.path).sort()).toEqual(['apps/api', 'apps/web', 'packages/shared']);
    });

    it('extracts java and spring from nested pom.xml', async () => {
      const allFiles = ['services/api/pom.xml', 'services/api/src/main/java/App.java'];
      const stackInfo = {
        languages: [
          {
            id: 'java',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['services/api/pom.xml:<java.version>'],
            version: '21',
          },
        ] as DetectedItem[],
        frameworks: [
          {
            id: 'spring-boot',
            confidence: 0.85,
            classification: 'derived_signal' as const,
            evidence: ['services/api/pom.xml:<parent><version>'],
            version: '3.4.1',
          },
        ] as DetectedItem[],
        buildTools: [
          {
            id: 'maven',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['services/api/pom.xml'],
          },
        ] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('services/api');
      expect(result[0]!.items.find((i) => i.id === 'java')).toBeDefined();
      expect(result[0]!.items.find((i) => i.id === 'spring-boot')).toBeDefined();
    });

    it('extracts database from nested docker-compose', async () => {
      // docker-compose at depth 1 creates scope (e.g., services/docker-compose.yml)
      const allFiles = ['services/docker-compose.yml', 'services/Dockerfile'];
      const stackInfo = {
        languages: [] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [
          {
            id: 'postgresql',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['services/docker-compose.yml:services.db.image'],
          },
        ] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('services');
      expect(result[0]!.items.find((i) => i.id === 'postgresql')).toBeDefined();
    });

    it('extracts database from docker-compose via readFile with image: evidence', async () => {
      const allFiles = ['services/docker-compose.yml'];
      const stackInfo = {
        languages: [] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };
      const readFile = async (path: string): Promise<string | undefined> => {
        if (path === 'services/docker-compose.yml') {
          return `version: '3.8'
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: example
  cache:
    image: redis:7-alpine
  mongo:
    image: mongo:7
`;
        }
        return undefined;
      };

      const result = await extractScopedStack(allFiles, stackInfo, readFile);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('services');
      const dbItems = result[0]!.items;
      expect(dbItems.find((i) => i.id === 'postgresql')).toBeDefined();
      expect(dbItems.find((i) => i.id === 'postgresql')?.version).toBe('16');
      expect(dbItems.find((i) => i.id === 'redis')).toBeDefined();
      expect(dbItems.find((i) => i.id === 'redis')?.version).toBe('7-alpine');
      expect(dbItems.find((i) => i.id === 'mongodb')).toBeDefined();
      expect(dbItems.find((i) => i.id === 'mongodb')?.version).toBe('7');
    });

    it('does NOT extract database from docker-compose text without image:', async () => {
      const allFiles = ['services/docker-compose.yml', 'services/Dockerfile'];
      const stackInfo = {
        languages: [
          {
            id: 'docker',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['services/Dockerfile'],
          },
        ] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };
      const readFile = async (path: string): Promise<string | undefined> => {
        if (path === 'services/docker-compose.yml') {
          return `version: '3.8'
services:
  app:
    build: .
    environment:
      # TODO: migrate to postgres later
      DATABASE_URL: postgresql://user:pass@db:5432/mydb
      # Redis is used for caching
      REDIS_URL: redis://cache:6379
`;
        }
        return undefined;
      };

      const result = await extractScopedStack(allFiles, stackInfo, readFile);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('services');
      const dbItems = result[0]!.items;
      expect(dbItems.find((i) => i.kind === 'database')).toBeUndefined();
    });
  });

  // ─── BAD: ignored directories ──────
  describe('BAD', () => {
    it('ignores examples directory', async () => {
      const allFiles = ['examples/demo/package.json', 'examples/demo/src/index.ts'];
      const stackInfo = {
        languages: [
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['examples/demo/package.json'],
          },
        ] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(0);
    });

    it('ignores fixtures directory', async () => {
      const allFiles = ['fixtures/test-setup/package.json'];
      const stackInfo = {
        languages: [
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['fixtures/test-setup/package.json'],
          },
        ] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(0);
    });

    it('does not create scope when evidence is not from within scope path', async () => {
      const allFiles = ['apps/web/package.json'];
      const stackInfo = {
        languages: [
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['package.json'],
          },
        ] as DetectedItem[], // evidence from root, not apps/web
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(0);
    });
  });

  // ─── CORNER: edge cases ──────
  describe('CORNER', () => {
    it('handles nested depth 2 paths', async () => {
      const allFiles = ['packages/ui/components/package.json'];
      const stackInfo = {
        languages: [
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['packages/ui/components/package.json'],
          },
        ] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe('packages/ui/components');
    });

    it('enforces max scopes limit', async () => {
      const allFiles = Array.from({ length: 30 }, (_, i) => `apps/app${i}/package.json`);
      const stackInfo = {
        languages: allFiles.map((f) => ({
          id: 'typescript',
          confidence: 0.9,
          classification: 'fact' as const,
          evidence: [f],
        })) as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result.length).toBeLessThanOrEqual(20);
    });

    it('returns empty array when no nested manifests found', async () => {
      const allFiles = ['src/index.ts', 'package.json', 'tsconfig.json'];
      const stackInfo = {
        languages: [
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['package.json'],
          },
        ] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result).toHaveLength(0);
    });

    it('sorts scopes by path', async () => {
      const allFiles = [
        'packages/zebra/package.json',
        'packages/alpha/package.json',
        'packages/beta/package.json',
      ];
      const stackInfo = {
        languages: [
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['packages/zebra/package.json'],
          },
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['packages/alpha/package.json'],
          },
          {
            id: 'typescript',
            confidence: 0.9,
            classification: 'fact' as const,
            evidence: ['packages/beta/package.json'],
          },
        ] as DetectedItem[],
        frameworks: [] as DetectedItem[],
        buildTools: [] as DetectedItem[],
        testFrameworks: [] as DetectedItem[],
        runtimes: [] as DetectedItem[],
        tools: [] as DetectedItem[],
        qualityTools: [] as DetectedItem[],
        databases: [] as DetectedItem[],
      };

      const result = await extractScopedStack(allFiles, stackInfo);

      expect(result.map((s) => s.path)).toEqual([
        'packages/alpha',
        'packages/beta',
        'packages/zebra',
      ]);
    });
  });

  // ─── EDGE: verify extractDetectedStack integration ──────
  describe('EDGE: extractDetectedStack integration', () => {
    it('extractDetectedStack includes scopes when allFiles provided', async () => {
      const { extractDetectedStack } = await import('./orchestrator');
      const { DiscoveryResultSchema } = await import('./types');

      const result = DiscoveryResultSchema.parse({
        schemaVersion: 'discovery.v1',
        collectedAt: new Date().toISOString(),
        collectors: { stack: 'complete' },
        repoMetadata: {
          fingerprint: 'abcdef0123456789abcdef01',
          defaultBranch: 'main',
          headCommit: 'abc123',
          isDirty: false,
          worktreePath: '/test',
          canonicalRemote: null,
        },
        stack: {
          languages: [
            {
              id: 'typescript',
              confidence: 0.9,
              classification: 'fact',
              evidence: ['apps/web/package.json'],
              version: '5.0',
            },
          ],
          frameworks: [
            {
              id: 'react',
              confidence: 0.85,
              classification: 'derived_signal',
              evidence: ['apps/web/package.json:dependencies.react'],
            },
          ],
          buildTools: [
            {
              id: 'pnpm',
              confidence: 0.9,
              classification: 'fact',
              evidence: ['apps/web/pnpm-lock.yaml'],
            },
          ],
          testFrameworks: [
            {
              id: 'vitest',
              confidence: 0.85,
              classification: 'derived_signal',
              evidence: ['apps/web/vitest.config.ts'],
            },
          ],
          runtimes: [],
          tools: [],
          qualityTools: [],
          databases: [],
        },
        topology: {
          kind: 'monorepo',
          modules: [],
          entryPoints: [],
          rootConfigs: [],
          ignorePaths: [],
        },
        surfaces: { api: [], persistence: [], cicd: [], security: [], layers: [] },
        domainSignals: { keywords: [], glossarySources: [] },
        validationHints: { checks: [], placeholderScripts: [], commands: [], lintTools: [] },
      });

      const detectedStack = await extractDetectedStack(result, [
        'apps/web/package.json',
        'apps/web/vitest.config.ts',
        'apps/web/pnpm-lock.yaml',
        'apps/web/src/index.tsx',
      ]);

      expect(detectedStack).not.toBeNull();
      expect(detectedStack!.scopes).toBeDefined();
      expect(detectedStack!.scopes!).toHaveLength(1);
      expect(detectedStack!.scopes![0]!.path).toBe('apps/web');
    });

    it('extractDetectedStack detects nested manifest facts via readFile', async () => {
      const { extractDetectedStack } = await import('./orchestrator');
      const { DiscoveryResultSchema } = await import('./types');

      const nestedPackageJson = JSON.stringify({
        name: 'web',
        dependencies: {
          react: '^18.2.0',
          'react-dom': '^18.2.0',
        },
        devDependencies: {
          vitest: '^1.0.0',
          eslint: '^8.50.0',
          prettier: '^3.0.0',
          typescript: '^5.0.0',
        },
        engines: {
          node: '>=20.11.0',
        },
      });

      const result = DiscoveryResultSchema.parse({
        schemaVersion: 'discovery.v1',
        collectedAt: new Date().toISOString(),
        collectors: { stack: 'complete' },
        repoMetadata: {
          fingerprint: 'abcdef0123456789abcdef01',
          defaultBranch: 'main',
          headCommit: 'abc123',
          isDirty: false,
          worktreePath: '/test',
          canonicalRemote: null,
        },
        stack: {
          languages: [
            {
              id: 'typescript',
              confidence: 0.9,
              classification: 'fact' as const,
              evidence: ['apps/web/package.json'],
              version: '5.0',
            },
          ],
          frameworks: [],
          buildTools: [],
          testFrameworks: [],
          runtimes: [],
          tools: [],
          qualityTools: [],
          databases: [],
        },
        topology: {
          kind: 'monorepo',
          modules: [],
          entryPoints: [],
          rootConfigs: [],
          ignorePaths: [],
        },
        surfaces: { api: [], persistence: [], cicd: [], security: [], layers: [] },
        domainSignals: { keywords: [], glossarySources: [] },
        validationHints: { checks: [], placeholderScripts: [], commands: [], lintTools: [] },
      });

      const readFile = async (path: string): Promise<string | undefined> => {
        if (path === 'apps/web/package.json') {
          return nestedPackageJson;
        }
        return undefined;
      };

      const detectedStack = await extractDetectedStack(result, ['apps/web/package.json'], readFile);

      expect(detectedStack).not.toBeNull();
      expect(detectedStack!.scopes).toBeDefined();
      expect(detectedStack!.scopes!).toHaveLength(1);
      expect(detectedStack!.scopes![0]!.path).toBe('apps/web');

      const scopeItems = detectedStack!.scopes![0]!.items;
      expect(scopeItems.map((i) => i.id)).toContain('react');
      expect(scopeItems.map((i) => i.id)).toContain('vitest');
      expect(scopeItems.map((i) => i.id)).toContain('node');

      const nodeItem = scopeItems.find((i) => i.id === 'node');
      expect(nodeItem?.version).toBe('20.11.0');
    });

    it('extractDetectedStack omits scopes when no nested manifests', async () => {
      const { extractDetectedStack } = await import('./orchestrator');
      const { DiscoveryResultSchema } = await import('./types');

      const result = DiscoveryResultSchema.parse({
        schemaVersion: 'discovery.v1',
        collectedAt: new Date().toISOString(),
        collectors: { stack: 'complete' },
        repoMetadata: {
          fingerprint: 'abcdef0123456789abcdef01',
          defaultBranch: 'main',
          headCommit: 'abc123',
          isDirty: false,
          worktreePath: '/test',
          canonicalRemote: null,
        },
        stack: {
          languages: [
            {
              id: 'typescript',
              confidence: 0.9,
              classification: 'fact',
              evidence: ['package.json'],
              version: '5.0',
            },
          ],
          frameworks: [],
          buildTools: [
            { id: 'pnpm', confidence: 0.9, classification: 'fact', evidence: ['pnpm-lock.yaml'] },
          ],
          testFrameworks: [],
          runtimes: [],
          tools: [],
          qualityTools: [],
          databases: [],
        },
        topology: {
          kind: 'single-project',
          modules: [],
          entryPoints: [],
          rootConfigs: [],
          ignorePaths: [],
        },
        surfaces: { api: [], persistence: [], cicd: [], security: [], layers: [] },
        domainSignals: { keywords: [], glossarySources: [] },
        validationHints: { checks: [], placeholderScripts: [], commands: [], lintTools: [] },
      });

      const detectedStack = await extractDetectedStack(result, ['package.json', 'src/index.ts']);

      expect(detectedStack).not.toBeNull();
      expect(detectedStack!.scopes).toBeUndefined();
    });
  });
});
