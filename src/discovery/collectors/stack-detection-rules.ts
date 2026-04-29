/**
 * @module discovery/collectors/stack-detection
 * @description Collector: technology stack detection.
 *
 * Detects languages, frameworks, build tools, test frameworks, runtimes,
 * ecosystem tools, quality tools, and database engines by analyzing file patterns, package
 * manifests, and config files.
 *
 * Detection strategy:
 * - File extensions → languages (fact)
 * - Package files → build tools (fact)
 * - packageManager field in package.json → package manager identity + version (fact, highest priority)
 * - Root-level lockfiles → package manager refinement: npm/pnpm/yarn/bun (fact, skipped when packageManager found)
 * - Config files → frameworks, test frameworks, quality tools (fact or derived_signal)
 * - package.json deps/devDeps → JS/TS ecosystem detection with versions (derived_signal)
 * - Root-level Python/Rust/Go manifests → ecosystem facts (derived_signal)
 * - Manifest content → version extraction (fact, requires readFile on input)
 * - pom.xml artifacts → tools, test frameworks, quality tools, databases (derived_signal)
 * - build.gradle(.kts) artifacts → tools, test frameworks, quality tools, databases (derived_signal)
 * - docker-compose image refs → databases + optional version when unambiguous (derived_signal)
 *
 * Each detected item carries confidence, classification, and evidence.
 * Version extraction is optional: when readFile is absent, items have no version.
 *
 * @version v4
 */

// ─── Detection Rules ──────────────────────────────────────────────────────────

/** Extension-based language detection. */
export const LANGUAGE_EXTENSIONS: ReadonlyArray<{
  id: string;
  extensions: ReadonlySet<string>;
}> = [
  { id: 'typescript', extensions: new Set(['.ts', '.tsx', '.mts', '.cts']) },
  { id: 'javascript', extensions: new Set(['.js', '.jsx', '.mjs', '.cjs']) },
  { id: 'java', extensions: new Set(['.java']) },
  { id: 'python', extensions: new Set(['.py', '.pyi']) },
  { id: 'go', extensions: new Set(['.go']) },
  { id: 'rust', extensions: new Set(['.rs']) },
  { id: 'csharp', extensions: new Set(['.cs']) },
  { id: 'ruby', extensions: new Set(['.rb']) },
  { id: 'php', extensions: new Set(['.php']) },
  { id: 'kotlin', extensions: new Set(['.kt', '.kts']) },
  { id: 'swift', extensions: new Set(['.swift']) },
  { id: 'scala', extensions: new Set(['.scala']) },
];

/** Package file → build tool mapping. */
export const BUILD_TOOL_RULES: ReadonlyArray<{
  id: string;
  packageFile: string;
}> = [
  { id: 'npm', packageFile: 'package.json' },
  { id: 'maven', packageFile: 'pom.xml' },
  { id: 'gradle', packageFile: 'build.gradle' },
  { id: 'gradle-kotlin', packageFile: 'build.gradle.kts' },
  { id: 'cargo', packageFile: 'Cargo.toml' },
  { id: 'go-modules', packageFile: 'go.mod' },
  { id: 'pip', packageFile: 'requirements.txt' },
  { id: 'setuptools', packageFile: 'setup.py' },
  { id: 'bundler', packageFile: 'Gemfile' },
  { id: 'composer', packageFile: 'composer.json' },
];

/** Build tools that must be backed by root-level evidence (P16 root-first). */
export const ROOT_FIRST_BUILD_TOOLS: ReadonlyArray<{ id: string; evidence: readonly string[] }> = [
  { id: 'pip', evidence: ['requirements.txt'] },
  { id: 'poetry', evidence: ['poetry.lock'] },
  { id: 'cargo', evidence: ['Cargo.toml'] },
  { id: 'go-modules', evidence: ['go.mod'] },
  { id: 'uv', evidence: ['uv.lock'] },
];

/** Root-level Python requirements files used for ecosystem signal extraction. */
export const PYTHON_REQUIREMENTS_FILES: readonly string[] = [
  'requirements.txt',
  'requirements-dev.txt',
];

/** Python package hints mapped to test/quality categories. */
export const PYTHON_ECOSYSTEM_PACKAGES: ReadonlyArray<{
  pkg: string;
  id: string;
  category: 'testFramework' | 'qualityTool';
}> = [
  { pkg: 'pytest', id: 'pytest', category: 'testFramework' },
  { pkg: 'ruff', id: 'ruff', category: 'qualityTool' },
  { pkg: 'black', id: 'black', category: 'qualityTool' },
  { pkg: 'mypy', id: 'mypy', category: 'qualityTool' },
];

// ─── Artifact Detection Rules ─────────────────────────────────────────────────

/** Artifact category for tool/quality/test/database detection. */
export type ArtifactCategory = 'tool' | 'testFramework' | 'qualityTool' | 'database';

/**
 * pom.xml artifact detection rules.
 *
 * Scans <dependency> and <plugin> blocks for known artifactIds.
 * Ordered by priority within each category. First match per id wins.
 */
export const POM_ARTIFACT_RULES: ReadonlyArray<{
  artifactId: string;
  id: string;
  category: ArtifactCategory;
  evidenceType: 'dependency' | 'plugin';
}> = [
  // Tools (P9 priority 1 & 3)
  {
    artifactId: 'openapi-generator-maven-plugin',
    id: 'openapi-generator',
    category: 'tool',
    evidenceType: 'plugin',
  },
  { artifactId: 'flyway-maven-plugin', id: 'flyway', category: 'tool', evidenceType: 'plugin' },
  { artifactId: 'flyway-core', id: 'flyway', category: 'tool', evidenceType: 'dependency' },
  { artifactId: 'liquibase-core', id: 'liquibase', category: 'tool', evidenceType: 'dependency' },
  // Test frameworks (P9 priority 2)
  {
    artifactId: 'junit-jupiter',
    id: 'junit',
    category: 'testFramework',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'junit-jupiter-api',
    id: 'junit',
    category: 'testFramework',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'cucumber-java',
    id: 'cucumber',
    category: 'testFramework',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'testcontainers',
    id: 'testcontainers',
    category: 'testFramework',
    evidenceType: 'dependency',
  },
  // Quality tools (P9 priority 5)
  {
    artifactId: 'spotless-maven-plugin',
    id: 'spotless',
    category: 'qualityTool',
    evidenceType: 'plugin',
  },
  {
    artifactId: 'maven-checkstyle-plugin',
    id: 'checkstyle',
    category: 'qualityTool',
    evidenceType: 'plugin',
  },
  {
    artifactId: 'archunit-junit5',
    id: 'archunit',
    category: 'qualityTool',
    evidenceType: 'dependency',
  },
  { artifactId: 'archunit', id: 'archunit', category: 'qualityTool', evidenceType: 'dependency' },
  {
    artifactId: 'jacoco-maven-plugin',
    id: 'jacoco',
    category: 'qualityTool',
    evidenceType: 'plugin',
  },
  // Database engines (P14)
  {
    artifactId: 'postgresql',
    id: 'postgresql',
    category: 'database',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'mysql-connector-j',
    id: 'mysql',
    category: 'database',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'mariadb-java-client',
    id: 'mariadb',
    category: 'database',
    evidenceType: 'dependency',
  },
  { artifactId: 'h2', id: 'h2', category: 'database', evidenceType: 'dependency' },
  {
    artifactId: 'sqlite-jdbc',
    id: 'sqlite',
    category: 'database',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'ojdbc8',
    id: 'oracle',
    category: 'database',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'ojdbc11',
    id: 'oracle',
    category: 'database',
    evidenceType: 'dependency',
  },
  {
    artifactId: 'mssql-jdbc',
    id: 'sqlserver',
    category: 'database',
    evidenceType: 'dependency',
  },
  // Testcontainers DB modules (supporting evidence)
  { artifactId: 'mysql', id: 'mysql', category: 'database', evidenceType: 'dependency' },
  {
    artifactId: 'mongodb',
    id: 'mongodb',
    category: 'database',
    evidenceType: 'dependency',
  },
];

/**
 * Gradle plugin detection rules.
 *
 * Matches id("plugin.id") version "x.y.z" declarations.
 * For built-in plugins (jacoco, checkstyle), also matches bare names and apply plugin.
 */
export const GRADLE_PLUGIN_RULES: ReadonlyArray<{
  pluginId: string;
  id: string;
  category: ArtifactCategory;
  builtin: boolean;
}> = [
  { pluginId: 'org.openapi.generator', id: 'openapi-generator', category: 'tool', builtin: false },
  { pluginId: 'org.flywaydb.flyway', id: 'flyway', category: 'tool', builtin: false },
  { pluginId: 'org.liquibase.gradle', id: 'liquibase', category: 'tool', builtin: false },
  { pluginId: 'com.diffplug.spotless', id: 'spotless', category: 'qualityTool', builtin: false },
  { pluginId: 'checkstyle', id: 'checkstyle', category: 'qualityTool', builtin: true },
  { pluginId: 'jacoco', id: 'jacoco', category: 'qualityTool', builtin: true },
];

/**
 * Gradle dependency detection rules.
 *
 * Matches "group:artifact:version" in dependency configurations.
 * Version part is optional (BOM-managed dependencies).
 */
export const GRADLE_DEPENDENCY_RULES: ReadonlyArray<{
  artifact: string;
  id: string;
  category: ArtifactCategory;
}> = [
  { artifact: 'junit-jupiter', id: 'junit', category: 'testFramework' },
  { artifact: 'junit-jupiter-api', id: 'junit', category: 'testFramework' },
  { artifact: 'cucumber-java', id: 'cucumber', category: 'testFramework' },
  { artifact: 'testcontainers', id: 'testcontainers', category: 'testFramework' },
  { artifact: 'flyway-core', id: 'flyway', category: 'tool' },
  { artifact: 'liquibase-core', id: 'liquibase', category: 'tool' },
  { artifact: 'archunit-junit5', id: 'archunit', category: 'qualityTool' },
  { artifact: 'archunit', id: 'archunit', category: 'qualityTool' },
  // Database engines (P14)
  { artifact: 'postgresql', id: 'postgresql', category: 'database' },
  { artifact: 'mysql-connector-j', id: 'mysql', category: 'database' },
  { artifact: 'mariadb-java-client', id: 'mariadb', category: 'database' },
  { artifact: 'h2', id: 'h2', category: 'database' },
  { artifact: 'sqlite-jdbc', id: 'sqlite', category: 'database' },
  { artifact: 'ojdbc8', id: 'oracle', category: 'database' },
  { artifact: 'ojdbc11', id: 'oracle', category: 'database' },
  { artifact: 'mssql-jdbc', id: 'sqlserver', category: 'database' },
  // Testcontainers DB modules (supporting evidence)
  { artifact: 'mysql', id: 'mysql', category: 'database' },
  { artifact: 'mongodb', id: 'mongodb', category: 'database' },
];

/** package.json dependency → database engine mapping (P14). */
export const JS_DATABASE_DEPS: ReadonlyArray<{ pkg: string; id: string }> = [
  { pkg: 'pg', id: 'postgresql' },
  { pkg: 'postgres', id: 'postgresql' },
  { pkg: 'mysql2', id: 'mysql' },
  { pkg: 'mysql', id: 'mysql' },
  { pkg: 'mariadb', id: 'mariadb' },
  { pkg: 'mongodb', id: 'mongodb' },
  { pkg: 'ioredis', id: 'redis' },
  { pkg: 'redis', id: 'redis' },
  { pkg: 'better-sqlite3', id: 'sqlite' },
  { pkg: 'sqlite3', id: 'sqlite' },
  { pkg: 'mssql', id: 'sqlserver' },
];

/** docker-compose image name → database engine mapping (P14). */
export const DOCKER_IMAGE_DATABASES: ReadonlyArray<{ image: string; id: string }> = [
  { image: 'postgres', id: 'postgresql' },
  { image: 'mysql', id: 'mysql' },
  { image: 'mariadb', id: 'mariadb' },
  { image: 'mongo', id: 'mongodb' },
  { image: 'mongodb', id: 'mongodb' },
  { image: 'redis', id: 'redis' },
  { image: 'oracle', id: 'oracle' },
  { image: 'sqlserver', id: 'sqlserver' },
];

/** Config file → framework/tool mapping. */
export const FRAMEWORK_CONFIG_RULES: ReadonlyArray<{
  id: string;
  configFiles: readonly string[];
  category: 'framework' | 'testFramework' | 'runtime' | 'qualityTool';
}> = [
  {
    id: 'angular',
    configFiles: ['angular.json'],
    category: 'framework',
  },
  {
    id: 'next',
    configFiles: ['next.config.js', 'next.config.mjs'],
    category: 'framework',
  },
  {
    id: 'nuxt',
    configFiles: ['nuxt.config.ts'],
    category: 'framework',
  },
  {
    id: 'vite',
    configFiles: ['vite.config.ts', 'vite.config.js'],
    category: 'framework',
  },
  {
    id: 'vitest',
    configFiles: ['vitest.config.ts', 'vitest.config.js'],
    category: 'testFramework',
  },
  {
    id: 'jest',
    configFiles: ['jest.config.js', 'jest.config.ts'],
    category: 'testFramework',
  },
  {
    id: 'webpack',
    configFiles: ['webpack.config.js'],
    category: 'framework',
  },
  {
    id: 'rollup',
    configFiles: ['rollup.config.js'],
    category: 'framework',
  },
  {
    id: 'nx',
    configFiles: ['nx.json'],
    category: 'framework',
  },
  {
    id: 'docker',
    configFiles: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'],
    category: 'runtime',
  },
  {
    id: 'tailwind',
    configFiles: ['tailwind.config.js', 'tailwind.config.ts'],
    category: 'framework',
  },
  {
    id: 'eslint',
    configFiles: [
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.yml',
      'eslint.config.js',
      'eslint.config.mjs',
    ],
    category: 'qualityTool',
  },
  {
    id: 'prettier',
    configFiles: ['.prettierrc', '.prettierrc.json'],
    category: 'qualityTool',
  },
];

// ─── JS/TS Ecosystem Detection ────────────────────────────────────────────────

/**
 * Category target for JS/TS ecosystem dependency mapping.
 *
 * Maps npm package names to detected item IDs and their stack categories.
 * Used by extractFromPackageJson() to scan dependencies and devDependencies.
 * Categories MUST match those used by FRAMEWORK_CONFIG_RULES for dedup to work.
 */
export type JsEcosystemCategory = 'framework' | 'testFramework' | 'qualityTool';

export const JS_ECOSYSTEM_DEPS: ReadonlyArray<{
  pkg: string;
  id: string;
  category: JsEcosystemCategory;
}> = [
  // ── Frameworks (Priority 1) ─────────────────────────────────────────────
  { pkg: 'react', id: 'react', category: 'framework' },
  { pkg: 'vue', id: 'vue', category: 'framework' },
  { pkg: 'next', id: 'next', category: 'framework' },
  { pkg: 'svelte', id: 'svelte', category: 'framework' },
  { pkg: '@sveltejs/kit', id: 'sveltekit', category: 'framework' },
  { pkg: 'astro', id: 'astro', category: 'framework' },
  { pkg: '@remix-run/node', id: 'remix', category: 'framework' },
  { pkg: '@remix-run/react', id: 'remix', category: 'framework' },
  { pkg: '@angular/core', id: 'angular', category: 'framework' },
  { pkg: 'nuxt', id: 'nuxt', category: 'framework' },
  // ── Test Frameworks (Priority 2) ────────────────────────────────────────
  { pkg: 'vitest', id: 'vitest', category: 'testFramework' },
  { pkg: 'jest', id: 'jest', category: 'testFramework' },
  { pkg: '@playwright/test', id: 'playwright', category: 'testFramework' },
  { pkg: 'cypress', id: 'cypress', category: 'testFramework' },
  // ── Quality Tools (Priority 3) ──────────────────────────────────────────
  { pkg: 'eslint', id: 'eslint', category: 'qualityTool' },
  { pkg: 'prettier', id: 'prettier', category: 'qualityTool' },
  { pkg: '@biomejs/biome', id: 'biome', category: 'qualityTool' },
  // ── Build Tools / Frameworks (Priority 4) ───────────────────────────────
  // vite/webpack/tailwind/nx are categorized as 'framework' in FRAMEWORK_CONFIG_RULES.
  // Using the same category here ensures config-detected + pkg-detected dedup works.
  { pkg: 'vite', id: 'vite', category: 'framework' },
  { pkg: 'webpack', id: 'webpack', category: 'framework' },
  { pkg: 'tailwindcss', id: 'tailwind', category: 'framework' },
  { pkg: 'nx', id: 'nx', category: 'framework' },
];

// ─── packageManager Field Detection ───────────────────────────────────────────

/**
 * Regex for the packageManager field in package.json (Corepack standard).
 *
 * Format: `"packageManager": "pnpm@9.12.0"` or `"yarn@4.1.0"` etc.
 * Captures: [1] = manager name (npm|pnpm|yarn|bun), [2] = version digits.
 */
export const PACKAGE_MANAGER_RE = /^(npm|pnpm|yarn|bun)@(\d+(?:\.\d+)*)/;

export const LOCKFILE_RULES: ReadonlyArray<{
  basename: string;
  id: string;
}> = [
  { basename: 'pnpm-lock.yaml', id: 'pnpm' },
  { basename: 'yarn.lock', id: 'yarn' },
  { basename: 'bun.lockb', id: 'bun' },
  { basename: 'bun.lock', id: 'bun' },
];
