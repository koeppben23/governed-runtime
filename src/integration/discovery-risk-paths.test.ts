import { describe, it, expect } from 'vitest';

import { discoveryRiskPaths } from './discovery-risk-paths.js';
import type { DiscoveryResult } from '../discovery/types.js';

function surface(id: string, evidence: string[]) {
  return { id, label: id, classification: 'fact' as const, evidence };
}
function signal(id: string, location: string) {
  return {
    id,
    label: id,
    confidence: 0.9,
    classification: 'fact' as const,
    evidence: [location],
    location,
  };
}

function discovery(overrides: {
  surfaces?: Partial<DiscoveryResult['surfaces']>;
  codeSurfaces?: Partial<NonNullable<DiscoveryResult['codeSurfaces']>>;
}): DiscoveryResult {
  return {
    surfaces: {
      api: [],
      persistence: [],
      cicd: [],
      security: [],
      layers: [],
      ...overrides.surfaces,
    },
    ...(overrides.codeSurfaces
      ? {
          codeSurfaces: {
            endpoints: [],
            authBoundaries: [],
            dataAccess: [],
            integrations: [],
            ...overrides.codeSurfaces,
          },
        }
      : {}),
  } as unknown as DiscoveryResult;
}

describe('discoveryRiskPaths', () => {
  it('returns [] for null/undefined discovery (never blocks)', () => {
    expect(discoveryRiskPaths(null)).toEqual([]);
    expect(discoveryRiskPaths(undefined)).toEqual([]);
  });

  it('collects surface evidence paths across api/persistence/cicd/security', () => {
    const result = discoveryRiskPaths(
      discovery({
        surfaces: {
          api: [surface('routes', ['src/api/routes.ts'])],
          persistence: [surface('repo', ['src/db/Repo.java'])],
          cicd: [surface('ci', ['.github/workflows/ci.yml'])],
          security: [surface('auth', ['src/security/Auth.java'])],
        },
      }),
    );
    expect(result).toEqual(
      [
        '.github/workflows/ci.yml',
        'src/api/routes.ts',
        'src/db/Repo.java',
        'src/security/Auth.java',
      ].sort(),
    );
  });

  it('collects code-surface signal locations', () => {
    const result = discoveryRiskPaths(
      discovery({
        codeSurfaces: {
          dataAccess: [signal('da', 'src/repo/TaskRepository.java')],
          authBoundaries: [signal('ab', 'src/security/Guard.java')],
        },
      }),
    );
    expect(result).toContain('src/repo/TaskRepository.java');
    expect(result).toContain('src/security/Guard.java');
  });

  it('deduplicates paths that appear in multiple surfaces', () => {
    const result = discoveryRiskPaths(
      discovery({
        surfaces: { security: [surface('s', ['src/security/Auth.java'])] },
        codeSurfaces: { authBoundaries: [signal('ab', 'src/security/Auth.java')] },
      }),
    );
    expect(result).toEqual(['src/security/Auth.java']);
  });

  it('ignores empty-string evidence/locations', () => {
    const result = discoveryRiskPaths(
      discovery({
        surfaces: { api: [surface('x', ['', 'src/a.ts'])] },
        codeSurfaces: { dataAccess: [signal('empty', ''), signal('real', 'src/b.ts')] },
      }),
    );
    expect(result).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
