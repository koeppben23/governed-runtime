/**
 * @module discovery/collectors/stack-detection
 * @description Collector: technology stack detection.
 *
 * Detects languages, frameworks, build tools, test frameworks, and runtimes
 * by analyzing file patterns, package manifests, and config files.
 *
 * Detection strategy:
 * - File extensions → languages (fact)
 * - Package files → build tools (fact)
 * - Config files → frameworks, test frameworks (fact or derived_signal)
 * - Dependency analysis via package.json → frameworks, runtimes (derived_signal)
 *
 * Each detected item carries confidence, classification, and evidence.
 *
 * @version v1
 */

import * as path from "node:path";
import type {
  CollectorInput,
  CollectorOutput,
  StackInfo,
  DetectedItem,
} from "../types";

// ─── Detection Rules ──────────────────────────────────────────────────────────

/** Extension-based language detection. */
const LANGUAGE_EXTENSIONS: ReadonlyArray<{
  id: string;
  extensions: ReadonlySet<string>;
}> = [
  { id: "typescript", extensions: new Set([".ts", ".tsx", ".mts", ".cts"]) },
  { id: "javascript", extensions: new Set([".js", ".jsx", ".mjs", ".cjs"]) },
  { id: "java", extensions: new Set([".java"]) },
  { id: "python", extensions: new Set([".py", ".pyi"]) },
  { id: "go", extensions: new Set([".go"]) },
  { id: "rust", extensions: new Set([".rs"]) },
  { id: "csharp", extensions: new Set([".cs"]) },
  { id: "ruby", extensions: new Set([".rb"]) },
  { id: "php", extensions: new Set([".php"]) },
  { id: "kotlin", extensions: new Set([".kt", ".kts"]) },
  { id: "swift", extensions: new Set([".swift"]) },
  { id: "scala", extensions: new Set([".scala"]) },
];

/** Package file → build tool mapping. */
const BUILD_TOOL_RULES: ReadonlyArray<{
  id: string;
  packageFile: string;
}> = [
  { id: "npm", packageFile: "package.json" },
  { id: "maven", packageFile: "pom.xml" },
  { id: "gradle", packageFile: "build.gradle" },
  { id: "gradle-kotlin", packageFile: "build.gradle.kts" },
  { id: "cargo", packageFile: "Cargo.toml" },
  { id: "go-modules", packageFile: "go.mod" },
  { id: "pip", packageFile: "requirements.txt" },
  { id: "poetry", packageFile: "pyproject.toml" },
  { id: "setuptools", packageFile: "setup.py" },
  { id: "bundler", packageFile: "Gemfile" },
  { id: "composer", packageFile: "composer.json" },
];

/** Config file → framework/tool mapping. */
const FRAMEWORK_CONFIG_RULES: ReadonlyArray<{
  id: string;
  configFiles: readonly string[];
  category: "framework" | "testFramework" | "runtime";
}> = [
  {
    id: "angular",
    configFiles: ["angular.json"],
    category: "framework",
  },
  {
    id: "next",
    configFiles: ["next.config.js", "next.config.mjs"],
    category: "framework",
  },
  {
    id: "nuxt",
    configFiles: ["nuxt.config.ts"],
    category: "framework",
  },
  {
    id: "vite",
    configFiles: ["vite.config.ts", "vite.config.js"],
    category: "framework",
  },
  {
    id: "vitest",
    configFiles: ["vitest.config.ts", "vitest.config.js"],
    category: "testFramework",
  },
  {
    id: "jest",
    configFiles: ["jest.config.js", "jest.config.ts"],
    category: "testFramework",
  },
  {
    id: "webpack",
    configFiles: ["webpack.config.js"],
    category: "framework",
  },
  {
    id: "rollup",
    configFiles: ["rollup.config.js"],
    category: "framework",
  },
  {
    id: "nx",
    configFiles: ["nx.json"],
    category: "framework",
  },
  {
    id: "docker",
    configFiles: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml"],
    category: "runtime",
  },
  {
    id: "tailwind",
    configFiles: ["tailwind.config.js", "tailwind.config.ts"],
    category: "framework",
  },
];

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect technology stack information.
 *
 * Scans file list, package files, and config files to detect:
 * - Languages (by file extension frequency)
 * - Build tools (by package manifest presence)
 * - Frameworks (by config file presence)
 * - Test frameworks (by config file presence)
 * - Runtimes (by config file presence)
 */
export async function collectStack(
  input: CollectorInput,
): Promise<CollectorOutput<StackInfo>> {
  try {
    const languages = detectLanguages(input.allFiles);
    const buildTools = detectBuildTools(input.packageFiles);
    const { frameworks, testFrameworks, runtimes } =
      detectFromConfigs(input.configFiles);

    return {
      status: "complete",
      data: { languages, frameworks, buildTools, testFrameworks, runtimes },
    };
  } catch {
    return {
      status: "failed",
      data: {
        languages: [],
        frameworks: [],
        buildTools: [],
        testFrameworks: [],
        runtimes: [],
      },
    };
  }
}

// ─── Internal Detection Functions ─────────────────────────────────────────────

/**
 * Detect languages by counting file extensions.
 * Confidence is proportional to the fraction of files with that extension.
 * Minimum 1 file to be detected.
 */
function detectLanguages(allFiles: readonly string[]): DetectedItem[] {
  if (allFiles.length === 0) return [];

  // Count files per language
  const counts = new Map<string, number>();
  const evidenceMap = new Map<string, string[]>();

  for (const filePath of allFiles) {
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) continue;

    for (const rule of LANGUAGE_EXTENSIONS) {
      if (rule.extensions.has(ext)) {
        counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
        const ev = evidenceMap.get(rule.id) ?? [];
        // Keep max 3 evidence paths per language
        if (ev.length < 3) ev.push(filePath);
        evidenceMap.set(rule.id, ev);
      }
    }
  }

  // Convert to DetectedItems with confidence based on relative count
  const total = allFiles.length;
  const items: DetectedItem[] = [];

  for (const [id, count] of counts) {
    // Confidence: min 0.3 for any presence, scaled up to 0.95 for dominant language
    const ratio = count / total;
    const confidence = Math.min(0.95, 0.3 + ratio * 0.65);

    items.push({
      id,
      confidence: Math.round(confidence * 100) / 100,
      classification: "fact",
      evidence: evidenceMap.get(id) ?? [],
    });
  }

  // Sort by confidence descending
  return items.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Detect build tools by presence of package manifest files.
 * Confidence is 0.9 (high — file presence is strong signal).
 */
function detectBuildTools(packageFiles: readonly string[]): DetectedItem[] {
  const packageSet = new Set(packageFiles);
  const items: DetectedItem[] = [];

  for (const rule of BUILD_TOOL_RULES) {
    if (packageSet.has(rule.packageFile)) {
      items.push({
        id: rule.id,
        confidence: 0.9,
        classification: "fact",
        evidence: [rule.packageFile],
      });
    }
  }

  return items;
}

/**
 * Detect frameworks, test frameworks, and runtimes from config files.
 * Confidence is 0.85 (config file presence is a strong signal).
 */
function detectFromConfigs(configFiles: readonly string[]): {
  frameworks: DetectedItem[];
  testFrameworks: DetectedItem[];
  runtimes: DetectedItem[];
} {
  const configSet = new Set(configFiles);
  const frameworks: DetectedItem[] = [];
  const testFrameworks: DetectedItem[] = [];
  const runtimes: DetectedItem[] = [];

  for (const rule of FRAMEWORK_CONFIG_RULES) {
    const matchedConfigs = rule.configFiles.filter((f) => configSet.has(f));
    if (matchedConfigs.length === 0) continue;

    const item: DetectedItem = {
      id: rule.id,
      confidence: 0.85,
      classification: "fact",
      evidence: matchedConfigs,
    };

    switch (rule.category) {
      case "framework":
        frameworks.push(item);
        break;
      case "testFramework":
        testFrameworks.push(item);
        break;
      case "runtime":
        runtimes.push(item);
        break;
    }
  }

  return { frameworks, testFrameworks, runtimes };
}
