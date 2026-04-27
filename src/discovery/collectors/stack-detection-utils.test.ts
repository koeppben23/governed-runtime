/**
 * @module discovery/collectors/stack-detection-utils.test
 * @description Unit tests for stack-detection-utils functions — targets uncovered branches.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import type { DetectedItem } from '../types.js';
import {
  setVersion,
  captureGroup,
  findItem,
  enrichDetectedItem,
  enrichDatabaseItem,
  mapComposeImageToDatabase,
  extractComposeTagVersion,
  setCompilerTarget,
  enrichOrCreateItem,
} from './stack-detection-utils.js';

function makeItem(id: string, overrides?: Partial<DetectedItem>): DetectedItem {
  return {
    id,
    confidence: 0.9,
    classification: 'derived_signal',
    evidence: ['detected'],
    ...overrides,
  };
}

// ─── setVersion ─────────────────────────────────────────────────────────────

describe('setVersion', () => {
  it('sets version and evidence', () => {
    const item = makeItem('test');
    setVersion(item, '1.0', 'evidence');
    expect(item.version).toBe('1.0');
    expect(item.versionEvidence).toBe('evidence');
  });
});

// ─── captureGroup ────────────────────────────────────────────────────────────

describe('captureGroup', () => {
  it('returns first capture group', () => {
    expect(captureGroup('hello world'.match(/(world)/))).toBe('world');
  });

  it('returns undefined for null match', () => {
    expect(captureGroup(null)).toBeUndefined();
  });

  it('returns undefined for match without groups', () => {
    expect(captureGroup('hello'.match(/hello/))).toBeUndefined();
  });
});

// ─── findItem ──────────────────────────────────────────────────────────────

describe('findItem', () => {
  it('finds item by id', () => {
    const items: DetectedItem[] = [makeItem('node'), makeItem('go')];
    expect(findItem(items, 'go')).toBe(items[1]);
  });

  it('returns undefined when not found', () => {
    expect(findItem([], 'rust')).toBeUndefined();
  });
});

// ─── enrichDetectedItem ──────────────────────────────────────────────────────

describe('enrichDetectedItem', () => {
  it('skips when item already exists (first-match-wins)', () => {
    const items: DetectedItem[] = [makeItem('postgresql')];
    enrichDetectedItem(items, 'postgresql', 'docker-compose.yml', '15.0');
    expect(items[0].version).toBeUndefined();
    expect(items[0].evidence).not.toContain('docker-compose.yml');
  });

  it('creates item when not found', () => {
    const items: DetectedItem[] = [];
    enrichDetectedItem(items, 'postgresql', 'docker-compose.yml', '15.0');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('postgresql');
    expect(items[0].version).toBe('15.0');
  });

  it('creates item without version when version is undefined', () => {
    const items: DetectedItem[] = [];
    enrichDetectedItem(items, 'postgresql', 'docker-compose.yml');
    expect(items).toHaveLength(1);
    expect(items[0].version).toBeUndefined();
  });
});

// ─── enrichDatabaseItem ─────────────────────────────────────────────────────

describe('enrichDatabaseItem', () => {
  it('adds database item when not present', () => {
    const dbs: DetectedItem[] = [];
    enrichDatabaseItem(dbs, 'postgresql', 'package.json:dependencies.pg');
    expect(dbs).toHaveLength(1);
    expect(dbs[0].id).toBe('postgresql');
  });

  it('does not overwrite existing database version', () => {
    const dbs: DetectedItem[] = [
      makeItem('postgresql', { version: '14.0', versionEvidence: 'prior' }),
    ];
    enrichDatabaseItem(dbs, 'postgresql', 'package.json:dependencies.pg');
    expect(dbs[0].version).toBe('14.0');
  });
});

// ─── mapComposeImageToDatabase ─────────────────────────────────────────────

describe('mapComposeImageToDatabase', () => {
  it('maps postgres image to postgresql', () => {
    const result = mapComposeImageToDatabase('postgres:15-alpine');
    expect(result).toBeDefined();
    expect(result!.id).toBe('postgresql');
    expect(result!.version).toBe('15');
  });

  it('returns null for unknown images', () => {
    expect(mapComposeImageToDatabase('unknown:latest')).toBeNull();
  });

  it('maps mysql image to mysql', () => {
    const result = mapComposeImageToDatabase('mysql:8');
    expect(result).toBeDefined();
    expect(result!.id).toBe('mysql');
    expect(result!.version).toBe('8');
  });

  it('maps mongo image to mongodb', () => {
    const result = mapComposeImageToDatabase('mongo:7.0');
    expect(result).toBeDefined();
    expect(result!.id).toBe('mongodb');
  });

  it('returns null for empty image string', () => {
    expect(mapComposeImageToDatabase('')).toBeNull();
  });

  it('handles images with registry and digest', () => {
    const result = mapComposeImageToDatabase('docker.io/postgres:15@sha256:abc123');
    expect(result).toBeDefined();
    expect(result!.id).toBe('postgresql');
  });

  it('returns null for interpolated tags', () => {
    expect(mapComposeImageToDatabase('postgres:${VERSION}')).toBeNull();
  });

  it('maps mssql/server images to sqlserver', () => {
    const result = mapComposeImageToDatabase('mcr.microsoft.com/mssql/server:2022-latest');
    expect(result).toBeDefined();
    expect(result!.id).toBe('sqlserver');
  });
});

// ─── extractComposeTagVersion ───────────────────────────────────────────────

describe('extractComposeTagVersion', () => {
  it('extracts version from tag', () => {
    expect(extractComposeTagVersion('postgres:15.2', { allowRegistryVersion: false })).toBe('15.2');
  });

  it('returns undefined for latest tag', () => {
    expect(
      extractComposeTagVersion('postgres:latest', { allowRegistryVersion: false }),
    ).toBeUndefined();
  });

  it('returns undefined for interpolated tags', () => {
    expect(
      extractComposeTagVersion('postgres:${VAR}', { allowRegistryVersion: false }),
    ).toBeUndefined();
  });

  it('returns undefined for registry-prefixed images when not allowed', () => {
    expect(
      extractComposeTagVersion('docker.io/library/postgres:15', { allowRegistryVersion: false }),
    ).toBeUndefined();
  });

  it('allows registry-prefixed when option is set', () => {
    expect(
      extractComposeTagVersion('docker.io/library/postgres:15', { allowRegistryVersion: true }),
    ).toBe('15');
  });
});

// ─── setCompilerTarget ──────────────────────────────────────────────────────

describe('setCompilerTarget', () => {
  it('sets compiler target and evidence', () => {
    const item = makeItem('typescript');
    setCompilerTarget(item, 'es2022', 'tsconfig.json');
    expect(item.compilerTarget).toBe('es2022');
    expect(item.compilerTargetEvidence).toBe('tsconfig.json');
  });
});

// ─── enrichOrCreateItem ─────────────────────────────────────────────────────

describe('enrichOrCreateItem', () => {
  it('creates item with version', () => {
    const items: DetectedItem[] = [];
    enrichOrCreateItem(items, 'pytest', 'requirements.txt', '7.0');
    expect(items).toHaveLength(1);
    expect(items[0].version).toBe('7.0');
  });

  it('enriches existing item that lacks a version', () => {
    const items: DetectedItem[] = [makeItem('pytest')];
    enrichOrCreateItem(items, 'pytest', 'requirements.txt', '7.0');
    expect(items[0].version).toBe('7.0');
  });

  it('does not overwrite existing version', () => {
    const items: DetectedItem[] = [
      makeItem('pytest', { version: '6.0', versionEvidence: 'prior' }),
    ];
    enrichOrCreateItem(items, 'pytest', 'requirements.txt', '7.0');
    expect(items[0].version).toBe('6.0');
  });
});
