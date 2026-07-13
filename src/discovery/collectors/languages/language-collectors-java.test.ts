import { describe, it, expect } from 'vitest';
import type { DetectedItem } from '../../types.js';
import { extractFromNodeVersionFiles } from './node.js';
import { extractFromPackageJson } from './js-ecosystem.js';
import {
  extractFromPomXml,
  extractFromGradleBuild,
  enrichFrameworkVersion,
  enrichRuntimeVersion,
  extractDatabasesFromDockerCompose,
  extractArtifactsFromPomXml,
} from './java.js';

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

describe('languages/java', () => {
  describe('enrichFrameworkVersion', () => {
    it('sets framework version when not already set', () => {
      const frameworks: DetectedItem[] = [makeItem('spring-boot')];
      enrichFrameworkVersion(frameworks, 'spring-boot', '3.4.1', 'build.gradle:springBootVersion');
      expect(frameworks[0]!.version).toBe('3.4.1');
    });

    it('does not overwrite existing framework version', () => {
      const frameworks: DetectedItem[] = [
        makeItem('spring-boot', { version: '3.3.0', versionEvidence: 'prior' }),
      ];
      enrichFrameworkVersion(frameworks, 'spring-boot', '3.4.1', 'build.gradle:springBootVersion');
      expect(frameworks[0]!.version).toBe('3.3.0');
    });

    it('creates framework when not yet in the array', () => {
      const frameworks: DetectedItem[] = [];
      enrichFrameworkVersion(frameworks, 'spring-boot', '3.4.1', 'build.gradle:springBootVersion');
      expect(frameworks).toHaveLength(1);
      expect(frameworks[0]!.version).toBe('3.4.1');
    });
  });

  describe('extractFromPomXml', () => {
    it('does nothing when pom.xml is absent', async () => {
      const frameworks: DetectedItem[] = [makeItem('spring-boot')];
      await extractFromPomXml(mockReadFile({}), [], frameworks);
      expect(frameworks[0]!.version).toBeUndefined();
    });

    it('detects java version from pom.xml', async () => {
      const languages: DetectedItem[] = [makeItem('java')];
      const frameworks: DetectedItem[] = [];
      await extractFromPomXml(
        mockReadFile({
          'pom.xml': `<project>
  <properties>
    <java.version>21</java.version>
  </properties>
</project>`,
        }),
        languages,
        frameworks,
      );
      expect(languages[0]!.version).toBe('21');
    });

    it('detects spring-boot from pom.xml parent artifact', async () => {
      const languages: DetectedItem[] = [];
      const frameworks: DetectedItem[] = [makeItem('spring-boot')];
      await extractFromPomXml(
        mockReadFile({
          'pom.xml': `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
  </parent>
</project>`,
        }),
        languages,
        frameworks,
      );
      const sb = frameworks.find((f) => f.id === 'spring-boot');
      expect(sb?.version).toBe('3.3.0');
    });
  });

  describe('extractFromGradleBuild', () => {
    it('detects springBootVersion from build.gradle', async () => {
      // Covers line 177: springBootVersion detection
      const languages: DetectedItem[] = [];
      const frameworks: DetectedItem[] = [];
      await extractFromGradleBuild(
        mockReadFile({
          'build.gradle': `ext {
    springBootVersion = '3.4.1'
}
`,
        }),
        languages,
        frameworks,
      );
      const sb = frameworks.find((f) => f.id === 'spring-boot');
      expect(sb).toBeDefined();
      expect(sb?.version).toBe('3.4.1');
    });

    it('detects spring-boot from gradle plugin declaration', async () => {
      const languages: DetectedItem[] = [];
      const frameworks: DetectedItem[] = [];
      await extractFromGradleBuild(
        mockReadFile({
          'build.gradle': `id 'org.springframework.boot' version '3.2.0'
`,
        }),
        languages,
        frameworks,
      );
      const sb = frameworks.find((f) => f.id === 'spring-boot');
      expect(sb).toBeDefined();
      expect(sb?.version).toBe('3.2.0');
    });
  });

  describe('enrichRuntimeVersion', () => {
    it('creates runtime item when not found', () => {
      const runtimes: DetectedItem[] = [];
      enrichRuntimeVersion(runtimes, 'java', '21', 'pom.xml:java.version');
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]!.version).toBe('21');
    });
  });

  describe('extractDatabasesFromDockerCompose', () => {
    it('detects postgres database from docker-compose.yml', async () => {
      const databases: DetectedItem[] = [];
      await extractDatabasesFromDockerCompose(
        mockReadFile({
          'docker-compose.yml': `services:
  db:
    image: postgres:15-alpine
`,
        }),
        ['docker-compose.yml'],
        databases,
      );
      const pg = databases.find((d) => d.id === 'postgresql');
      expect(pg).toBeDefined();
      expect(pg?.version).toBe('15');
    });

    it('detects database from docker-compose.override.yml', async () => {
      const databases: DetectedItem[] = [];
      await extractDatabasesFromDockerCompose(
        mockReadFile({
          'docker-compose.override.yml': `services:
  redis:
    image: redis:7-alpine
`,
        }),
        ['docker-compose.override.yml'],
        databases,
      );
      const redis = databases.find((d) => d.id === 'redis');
      expect(redis).toBeDefined();
      expect(redis?.version).toBe('7');
    });

    it('skips compose files without image fields', async () => {
      const databases: DetectedItem[] = [];
      await extractDatabasesFromDockerCompose(
        mockReadFile({
          'docker-compose.yml': `services:
  web:
    build: .
`,
        }),
        ['docker-compose.yml'],
        databases,
      );
      expect(databases).toHaveLength(0);
    });

    it('handles docker-compose files without database images', async () => {
      const databases: DetectedItem[] = [];
      await extractDatabasesFromDockerCompose(
        mockReadFile({
          'docker-compose.yml': `services:
  web:
    image: nginx:alpine
`,
        }),
        ['docker-compose.yml'],
        databases,
      );
      expect(databases).toHaveLength(0);
    });
  });

  describe('extractArtifactsFromPomXml', () => {
    it('detects openapi-generator plugin from pom.xml', async () => {
      const testFrameworks: DetectedItem[] = [];
      const tools: DetectedItem[] = [];
      const qualityTools: DetectedItem[] = [];
      const databases: DetectedItem[] = [];
      await extractArtifactsFromPomXml(
        mockReadFile({
          'pom.xml': `<project>
  <build>
    <plugins>
      <plugin>
        <groupId>org.openapitools</groupId>
        <artifactId>openapi-generator-maven-plugin</artifactId>
        <version>7.2.0</version>
      </plugin>
    </plugins>
  </build>
</project>`,
        }),
        testFrameworks,
        tools,
        qualityTools,
        databases,
      );
      expect(tools.find((t) => t.id === 'openapi-generator')).toBeDefined();
    });
  });
  describe('EDGE', () => {
    it('extractFromNodeVersionFiles handles file with no version content', async () => {
      const runtimes = [makeItem('node')];
      await extractFromNodeVersionFiles(mockReadFile({ '.nvmrc': '# comment only\n' }), runtimes);
      expect(runtimes[0]!.version).toBeUndefined();
    });

    it('extractFromPackageJson handles engines.node with non-version constraint', async () => {
      const runtimes = [makeItem('node')];
      await extractFromPackageJson(
        mockReadFile({ 'package.json': JSON.stringify({ engines: { node: 'latest' } }) }),
        [],
        [],
        runtimes,
        [],
        [],
        [],
      );
      expect(runtimes[0]!.version).toBeUndefined();
    });

    it('extractFromPackageJson handles devDependencies missing typescript item', async () => {
      const languages: DetectedItem[] = [];
      const frameworks: DetectedItem[] = [];
      const databases: DetectedItem[] = [];
      await extractFromPackageJson(
        mockReadFile({
          'package.json': JSON.stringify({ devDependencies: { typescript: '^5.3' } }),
        }),
        languages,
        frameworks,
        [],
        [],
        [],
        databases,
      );
      expect(languages).toHaveLength(0);
    });
  });

  describe('java artifact edge cases', () => {
    it('extractArtifactsFromPomXml skips when pom.xml has no content', async () => {
      const testFrameworks: DetectedItem[] = [];
      const tools: DetectedItem[] = [];
      const qualityTools: DetectedItem[] = [];
      const databases: DetectedItem[] = [];
      await extractArtifactsFromPomXml(
        mockReadFile({}),
        testFrameworks,
        tools,
        qualityTools,
        databases,
      );
      expect(tools).toHaveLength(0);
    });

    it('extractFromPomXml skips when pom.xml is missing', async () => {
      await extractFromPomXml(mockReadFile({}), [], []);
    });
  });
});
