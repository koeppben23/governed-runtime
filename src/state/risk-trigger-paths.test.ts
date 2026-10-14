import { describe, it, expect } from 'vitest';
import { assessMinimumTaskClass } from './risk-path-classifier.js';
import { RiskTriggerPathsSchema } from './risk-trigger-paths.js';
import { matchesRepositoryGlob, normalizeRepoRelativePath } from '../shared/repo-path.js';

describe('frozen repository-specific authority surfaces', () => {
  it('maps the actual Java state store rather than all Java source', () => {
    const rules = RiskTriggerPathsSchema.parse([
      { trigger: 'state_integrity', pattern: 'src/main/java/store/**' },
    ]);
    expect(assessMinimumTaskClass(['src/main/java/store/State.java'], rules)).toMatchObject({
      minimumTaskClass: 'HIGH-RISK',
      riskTriggers: ['state_integrity'],
    });
    expect(assessMinimumTaskClass(['src/main/java/ui/View.java'], rules)).toMatchObject({
      minimumTaskClass: 'STANDARD',
      riskTriggers: [],
    });
  });
  it.each([
    'pom.xml',
    'go.mod',
    'go.sum',
    'pyproject.toml',
    'requirements-dev.txt',
    '.github/workflows/test.yml',
    'gradle/wrapper/gradle-wrapper.properties',
  ])('assigns HIGH-RISK and distribution integrity together: %s', (file) => {
    expect(assessMinimumTaskClass([file])).toMatchObject({
      minimumTaskClass: 'HIGH-RISK',
      riskTriggers: ['distribution_integrity'],
    });
  });
  it.each(['vitest.config.ts', 'jest.config.js', 'pytest.ini', 'tests/conftest.py', 'tox.ini'])(
    'never treats verification configuration as trivial: %s',
    (file) => {
      expect(assessMinimumTaskClass([file]).minimumTaskClass).toBe('STANDARD');
    },
  );
  it.each(['../secret', '/root/**', 'a\\b', 'a/**b', 'a//b'])(
    'rejects ambiguous/non-repository patterns: %s',
    (pattern) => {
      expect(
        RiskTriggerPathsSchema.safeParse([{ trigger: 'state_integrity', pattern }]).success,
      ).toBe(false);
    },
  );
  it('cannot cover ceremony_only', () => {
    expect(
      RiskTriggerPathsSchema.safeParse([{ trigger: 'ceremony_only', pattern: 'src/**' }]).success,
    ).toBe(false);
  });
  it('matches zero or multiple segments deterministically', () => {
    expect(matchesRepositoryGlob('**/*.py', 'test.py')).toBe(true);
    expect(matchesRepositoryGlob('**/*.py', 'a/b/test.py')).toBe(true);
    expect(matchesRepositoryGlob('src/*.py', 'src/a/test.py')).toBe(false);
    expect(normalizeRepoRelativePath('src\\store\\State.java')).toBe('src/store/State.java');
  });
});
