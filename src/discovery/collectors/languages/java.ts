/**
 * @module discovery/collectors/languages/java
 * @description Java ecosystem detection — pom.xml, build.gradle, docker-compose artifact extraction.
 * Extracted from stack-detection.ts.
 * @version v1
 */

import type { DetectedItem } from '../../types.js';
import { getRootBasename } from '../../repo-paths.js';
import {
  type ReadFileFn,
  safeRead,
  captureGroup,
  findItem,
  setVersion,
  resolveTargetArray,
  enrichDetectedItem,
  enrichDatabaseItem,
  mapComposeImageToDatabase,
} from '../stack-detection-utils.js';
import {
  POM_ARTIFACT_RULES,
  GRADLE_PLUGIN_RULES,
  GRADLE_DEPENDENCY_RULES,
} from '../stack-detection-rules.js';

export async function extractFromPomXml(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
): Promise<void> {
  const content = await safeRead(readFile, 'pom.xml');
  if (!content) return;

  // <java.version>21</java.version>
  const javaVer = captureGroup(
    content.match(/<java\.version>\s*(\d+(?:\.\d+)*)\s*<\/java\.version>/),
  );
  if (javaVer) {
    const javaItem = findItem(languages, 'java');
    if (javaItem && !javaItem.version) {
      setVersion(javaItem, javaVer, 'pom.xml:<java.version>');
    }
  }

  // <maven.compiler.source>21</maven.compiler.source> (alternative Java version)
  if (!javaVer) {
    const compilerVer = captureGroup(
      content.match(/<maven\.compiler\.source>\s*(\d+(?:\.\d+)*)\s*<\/maven\.compiler\.source>/),
    );
    if (compilerVer) {
      const javaItem = findItem(languages, 'java');
      if (javaItem && !javaItem.version) {
        setVersion(javaItem, compilerVer, 'pom.xml:<maven.compiler.source>');
      }
    }
  }

  // Spring Boot version from <spring-boot.version> or parent artifact version
  const sbVer = captureGroup(
    content.match(
      /<spring-boot\.version>\s*(\d+(?:\.\d+)*(?:[.-][A-Za-z0-9]+)*)\s*<\/spring-boot\.version>/,
    ),
  );
  if (sbVer) {
    enrichFrameworkVersion(frameworks, 'spring-boot', sbVer, 'pom.xml:<spring-boot.version>');
    return;
  }

  // Fallback: Spring Boot parent version
  const parentVer = captureGroup(
    content.match(
      /<parent>[\s\S]*?<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>[\s\S]*?<version>\s*(\d+(?:\.\d+)*(?:[.-][A-Za-z0-9]+)*)\s*<\/version>[\s\S]*?<\/parent>/,
    ),
  );
  if (parentVer) {
    enrichFrameworkVersion(frameworks, 'spring-boot', parentVer, 'pom.xml:parent.version');
  }
}

/** Add or enrich a framework item with version info. */
export function enrichFrameworkVersion(
  frameworks: DetectedItem[],
  id: string,
  version: string,
  evidence: string,
): void {
  let item = findItem(frameworks, id);
  if (!item) {
    // Spring Boot may not have been detected via config files — add it
    item = {
      id,
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: [evidence],
    };
    frameworks.push(item);
  }
  if (!item.version) {
    setVersion(item, version, evidence);
  }
}

/** Add or enrich a runtime item with version info. */
export function enrichRuntimeVersion(
  runtimes: DetectedItem[],
  id: string,
  version: string,
  evidence: string,
): void {
  let item = findItem(runtimes, id);
  if (!item) {
    item = {
      id,
      confidence: 0.85,
      classification: 'derived_signal',
      evidence: [evidence],
    };
    runtimes.push(item);
  }
  if (!item.version) {
    setVersion(item, version, evidence);
  }
}

/**
 * Extract Java and Spring Boot versions from build.gradle or build.gradle.kts.
 * Conservative: only matches sourceCompatibility, JavaLanguageVersion.of(),
 * and Spring Boot plugin declarations.
 */
export async function extractFromGradleBuild(
  readFile: ReadFileFn,
  languages: DetectedItem[],
  frameworks: DetectedItem[],
): Promise<void> {
  for (const file of ['build.gradle.kts', 'build.gradle']) {
    const content = await safeRead(readFile, file);
    if (!content) continue;

    // ── Java version ──────────────────────────────────────────────────────
    const javaItem = findItem(languages, 'java');
    if (javaItem && !javaItem.version) {
      // JavaLanguageVersion.of(21) — Gradle Kotlin DSL / Groovy toolchain API
      const toolchainVer = captureGroup(content.match(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/));
      if (toolchainVer) {
        setVersion(javaItem, toolchainVer, `${file}:JavaLanguageVersion.of`);
      } else {
        // sourceCompatibility = JavaVersion.VERSION_21 or sourceCompatibility = '21'
        const srcCompatMatch = content.match(
          /sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_(\d+)|['"](\d+)['"]|(\d+))/,
        );
        if (srcCompatMatch) {
          const ver = srcCompatMatch[1] ?? srcCompatMatch[2] ?? srcCompatMatch[3];
          if (ver) {
            setVersion(javaItem, ver, `${file}:sourceCompatibility`);
          }
        }
      }
    }

    // ── Spring Boot version from plugin declaration ───────────────────────
    // id("org.springframework.boot") version "4.0.1" (Kotlin DSL)
    // id 'org.springframework.boot' version '4.0.1' (Groovy DSL)
    const sbPluginVer = captureGroup(
      content.match(
        /id\s*\(?['"]org\.springframework\.boot['"]\)?\s+version\s+['"](\d+(?:\.\d+)*(?:[.-][A-Za-z0-9]+)*)['"]/,
      ),
    );
    if (sbPluginVer) {
      enrichFrameworkVersion(frameworks, 'spring-boot', sbPluginVer, `${file}:plugin.spring-boot`);
    } else {
      // springBootVersion = "4.0.1" or springBootVersion = '4.0.1'
      const sbVarVer = captureGroup(
        content.match(/springBootVersion\s*=\s*['"](\d+(?:\.\d+)*(?:[.-][A-Za-z0-9]+)*)['"]/),
      );
      if (sbVarVer) {
        enrichFrameworkVersion(frameworks, 'spring-boot', sbVarVer, `${file}:springBootVersion`);
      }
    }

    return; // First file with content wins (build.gradle.kts preferred)
  }
}

/**
 * Extract Go version from go.mod directive.
 * Format: `go 1.22` or `go 1.22.1`.
 */
export async function extractArtifactsFromPomXml(
  readFile: ReadFileFn,
  testFrameworks: DetectedItem[],
  tools: DetectedItem[],
  qualityTools: DetectedItem[],
  databases: DetectedItem[],
): Promise<void> {
  const content = await safeRead(readFile, 'pom.xml');
  if (!content) return;

  // Extract all <dependency>...</dependency> and <plugin>...</plugin> blocks
  const blocks = [
    ...content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g),
    ...content.matchAll(/<plugin>([\s\S]*?)<\/plugin>/g),
  ];

  const detected = new Set<string>();

  for (const rule of POM_ARTIFACT_RULES) {
    if (detected.has(rule.id)) continue;

    for (const [, blockContent] of blocks) {
      if (!blockContent) continue;
      if (!new RegExp(`<artifactId>\\s*${rule.artifactId}\\s*</artifactId>`).test(blockContent)) {
        continue;
      }

      // Found artifact — try to extract version from same block
      const versionMatch = blockContent.match(
        /<version>\s*(\d+(?:\.\d+)*(?:[.-][A-Za-z0-9+]*)*)\s*<\/version>/,
      );
      const version = versionMatch?.[1];
      const evidence = `pom.xml:${rule.evidenceType}.${rule.artifactId}`;
      const targetArray = resolveTargetArray(
        rule.category,
        testFrameworks,
        tools,
        qualityTools,
        databases,
      );

      if (rule.category === 'database') {
        enrichDatabaseItem(targetArray, rule.id, evidence);
      } else {
        enrichDetectedItem(targetArray, rule.id, evidence, version);
      }
      detected.add(rule.id);
      break; // Found in a block, move to next rule
    }
  }
}

/**
 * Extract tool/testFramework/qualityTool artifacts from build.gradle(.kts).
 *
 * Scans plugin declarations and dependency configurations for known artifacts.
 * Runs AFTER pom.xml extraction — Maven is authoritative; Gradle values are
 * only added for IDs not already detected (first-write-wins across files).
 */
export async function extractArtifactsFromGradle(
  readFile: ReadFileFn,
  testFrameworks: DetectedItem[],
  tools: DetectedItem[],
  qualityTools: DetectedItem[],
  databases: DetectedItem[],
): Promise<void> {
  let content: string | undefined;
  let file: string | undefined;

  for (const candidate of ['build.gradle.kts', 'build.gradle']) {
    content = await safeRead(readFile, candidate);
    if (content) {
      file = candidate;
      break;
    }
  }
  if (!content || !file) return;

  // ── Plugin declarations with explicit version ──────────────────────────
  for (const rule of GRADLE_PLUGIN_RULES) {
    const targetArray = resolveTargetArray(
      rule.category,
      testFrameworks,
      tools,
      qualityTools,
      databases,
    );
    if (findItem(targetArray, rule.id)) continue; // first-match-wins

    const escapedId = rule.pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // id("plugin.id") version "1.2.3" or id 'plugin.id' version '1.2.3'
    const pluginMatch = content.match(
      new RegExp(
        `id\\s*\\(?['"]${escapedId}['"]\\)?\\s+version\\s+['"](\\d+(?:\\.\\d+)*(?:[.-][A-Za-z0-9+]*)*)['"]`,
      ),
    );
    if (pluginMatch) {
      enrichDetectedItem(targetArray, rule.id, `${file}:plugin.${rule.id}`, pluginMatch[1]);
      continue;
    }

    // Built-in plugins: bare name on own line or apply plugin: 'name'
    if (rule.builtin) {
      const applied =
        new RegExp(`apply\\s+plugin:\\s*['"]${escapedId}['"]`).test(content) ||
        new RegExp(`^\\s*${escapedId}\\s*$`, 'm').test(content);
      if (applied) {
        enrichDetectedItem(targetArray, rule.id, `${file}:plugin.${rule.id}`);
      }
    }
  }

  // ── Dependency declarations: "group:artifact:version" or "group:artifact" ──
  for (const rule of GRADLE_DEPENDENCY_RULES) {
    const targetArray = resolveTargetArray(
      rule.category,
      testFrameworks,
      tools,
      qualityTools,
      databases,
    );
    if (findItem(targetArray, rule.id)) continue; // first-match-wins

    const depMatch = content.match(
      new RegExp(`['"][\\w.-]+:${rule.artifact}(?::(\\d+(?:\\.\\d+)*(?:[.-][A-Za-z0-9+]*)*))?['"]`),
    );
    if (!depMatch) continue;

    if (rule.category === 'database') {
      enrichDatabaseItem(targetArray, rule.id, `${file}:dependency.${rule.artifact}`);
    } else {
      enrichDetectedItem(targetArray, rule.id, `${file}:dependency.${rule.artifact}`, depMatch[1]);
    }
  }
}

/**
 * Extract database engines from docker-compose image declarations.
 *
 * Conservative detection:
 * - Scans only docker-compose*.yml/yaml files listed in allFiles
 * - Parses only `image:` lines
 * - Maps known image names to engines
 * - Extracts version only when tag is unambiguous and starts with digits
 */
export async function extractDatabasesFromDockerCompose(
  readFile: ReadFileFn,
  allFiles: readonly string[],
  databases: DetectedItem[],
): Promise<void> {
  const composeFiles = allFiles.filter((filePath) => {
    const base = getRootBasename(filePath)?.toLowerCase();
    if (!base) return false;
    return /^docker-compose(?:[.-][a-z0-9_.-]+)?\.ya?ml$/.test(base);
  });

  for (const file of composeFiles) {
    const content = await safeRead(readFile, file);
    if (!content) continue;

    for (const match of content.matchAll(/^\s*image\s*:\s*['"]?([^'"\s]+)['"]?/gm)) {
      const imageRef = match[1]?.trim();
      if (!imageRef) continue;

      const mapped = mapComposeImageToDatabase(imageRef);
      if (!mapped) continue;

      const evidence = `${file}:image ${imageRef}`;
      enrichDatabaseItem(databases, mapped.id, evidence, mapped.version);
    }
  }
}
