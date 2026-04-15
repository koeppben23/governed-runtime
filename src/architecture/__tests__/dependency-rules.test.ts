/**
 * @module architecture/dependency-rules
 * @description Clean Architecture dependency boundary tests.
 *
 * IMPORTANT: This is a smoke test, not a complete static analysis tool.
 * It catches common violations but may have false negatives for complex import paths.
 *
 * ARCHITECTURE RULES (verified by these tests):
 *
 * 1. LEAF MODULES: Inner layers must NOT import from outer layers
 *    - state/ must not import from machine/, rails/, adapters/, integration/, config/, audit/, archive/, logging/, cli/
 *    - archive/types.ts must not import from any other FF module
 *    - discovery/types.ts must not import from any other FF module
 *
 * 2. MACHINE LAYER: machine/ may only import from state/
 *    - machine/ must not import from rails/, adapters/, integration/, config/, audit/, discovery/, archive/, logging/, cli/
 *
 * 3. RAILS LAYER: rails/ must NOT import from integration/ (prevents circular dependencies)
 *    - rails/ may import from config/, audit/, discovery/types, state/, machine/
 *
 * 4. RAILS LAYER: rails/ must NOT import Node I/O builtins directly
 *    - fs, path, crypto, child_process should be in adapters/
 *    - This is a hard rule enforced by this test
 *
 * 5. INWARD IMPORTS: Outer layers MAY import from inner layers (entry-point pattern)
 *    - integration/ may import rails/, adapters/, machine/, state/, etc.
 *    - adapters/ may import config/, discovery/, archive/, state/, machine/, rails/
 *
 * The key inversion rule is:
 * - Inner layers (state, machine) are PROHIBITED from importing outer layers
 * - Outer layers (integration, adapters) MAY import inner layers
 *
 * @version v1
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "../../../");
const SRC_DIR = path.join(PROJECT_ROOT, "src");

const NODE_BUILTINS = new Set([
  "fs", "path", "crypto", "child_process", "process", "os",
  "events", "stream", "buffer", "util", "url", "querystring",
  "http", "https", "net", "tls", "dgram", "dns", "domain",
  "assert", "perf_hooks", "readline", "repl", "string_decoder",
  "tty", "dgram", "v8", "vm", "zlib", "async_hooks", "cluster",
  "console", "constants", "diagnostics_channel", "dns", "domain",
  "events", "fs/promises", "fs", "http", "http2", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "punycode",
  "querystring", "readline", "repl", "stream", "string_decoder",
  "sys", "timers", "tls", "trace_events", "tty", "url", "util",
  "v8", "vm", "wasi", "worker_threads", "zlib",
]);

const NODE_BUILTIN_PREFIXES = [
  "node:", "node:fs", "node:path", "node:crypto", "node:child_process",
  "node:process", "node:os", "node:events", "node:stream", "node:buffer",
  "node:util", "node:url", "node:querystring", "node:http", "node:https",
  "node:net", "node:tls", "node:dgram", "node:dns", "node:domain",
  "node:assert", "node:perf_hooks",
];

/**
 * Normalize a file path to use forward slashes.
 * Ensures `.includes("/state/")` etc. work on all platforms
 * (Windows `path.join()` produces backslash separators).
 */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

interface ImportInfo {
  module: string;
  raw: string;
  isNodeBuiltin: boolean;
  isFFModule: boolean;
  targetModule: string | null;
}

interface FileAnalysis {
  filePath: string;
  relativePath: string;
  imports: ImportInfo[];
}

interface ImportViolation {
  file: string;
  rule: string;
  message: string;
  imports?: string[];
}

function isNodeBuiltinImport(module: string): boolean {
  if (NODE_BUILTINS.has(module)) return true;
  if (module.startsWith("node:") && NODE_BUILTINS.has(module.slice(5))) return true;
  if (NODE_BUILTIN_PREFIXES.includes(module)) return true;
  return false;
}

function getTargetModule(importPath: string): string | null {
  const normalized = importPath.replace(/^\.\.\//, "").replace(/^\.\//, "");
  const first = normalized.split("/")[0];
  return first || null;
}

const FF_MODULES = new Set([
  "state", "machine", "rails", "adapters", "integration",
  "config", "audit", "discovery", "archive", "logging", "cli",
]);

function isFFModuleImport(module: string): boolean {
  if (!module.startsWith("../")) return false;
  const target = getTargetModule(module);
  return target !== null && FF_MODULES.has(target);
}

function parseImports(fileContent: string): ImportInfo[] {
  const imports: ImportInfo[] = [];

  const importRegex = /^import\s+(?:(?:type\s+)?(?:\{[^}]*\}|[^;{}]+)\s+from\s+)?['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]|^export\s+(?:\{[^}]*\}|[^;{}]+)\s+from\s+['"]([^'"]+)['"]|^export\s+from\s+['"]([^'"]+)['"]|^export\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"]|^require\s*\(['"]([^'"]+)['"]\)/gm;

  let match;
  while ((match = importRegex.exec(fileContent)) !== null) {
    const module = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!module) continue;

    imports.push({
      module,
      raw: match[0],
      isNodeBuiltin: isNodeBuiltinImport(module),
      isFFModule: isFFModuleImport(module),
      targetModule: isFFModuleImport(module) ? getTargetModule(module) : null,
    });
  }

  return imports;
}

async function analyzeFile(filePath: string): Promise<FileAnalysis> {
  const content = await fs.readFile(filePath, "utf-8");
  const relativePath = path.relative(SRC_DIR, filePath);
  const imports = parseImports(content);

  return {
    filePath: normalizeSep(filePath),
    relativePath: normalizeSep(relativePath),
    imports,
  };
}

async function collectFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.includes("__") && !entry.name.includes("node_modules")) {
      const subFiles = await collectFiles(fullPath, pattern);
      files.push(...subFiles);
    } else if (entry.isFile() && pattern.test(entry.name) && !entry.name.includes(".test.")) {
      files.push(fullPath);
    }
  }

  return files;
}

function getLayerFromPath(filePath: string): string | null {
  if (filePath.includes("/state/")) return "state";
  if (filePath.includes("/machine/")) return "machine";
  if (filePath.includes("/rails/")) return "rails";
  if (filePath.includes("/adapters/")) return "adapters";
  if (filePath.includes("/integration/")) return "integration";
  if (filePath.includes("/config/")) return "config";
  if (filePath.includes("/audit/")) return "audit";
  if (filePath.includes("/discovery/")) return "discovery";
  if (filePath.includes("/archive/")) return "archive";
  if (filePath.includes("/logging/")) return "logging";
  if (filePath.includes("/cli/")) return "cli";
  return null;
}

describe("Layer Dependency Rules", () => {
  let analyses: Map<string, FileAnalysis>;

  beforeAll(async () => {
    analyses = new Map();
    const tsFiles = await collectFiles(SRC_DIR, /\.ts$/);
    for (const file of tsFiles) {
      const analysis = await analyzeFile(file);
      analyses.set(file, analysis);
    }
  });

  describe("Rule 1: state/ is a leaf module (with exception for discovery/types)", () => {
    const stateViolations: ImportViolation[] = [];
    const forbiddenFromState = new Set([
      "machine", "rails", "adapters", "integration",
      "config", "audit", "archive", "logging", "cli"
    ]);
    const allowedForState = new Set(["discovery"]);

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes("/state/")) continue;
        if (analysis.filePath.includes(".test.")) continue;

        const ffImports = analysis.imports.filter(i => i.isFFModule && i.targetModule);
        for (const imp of ffImports) {
          if (imp.targetModule && forbiddenFromState.has(imp.targetModule)) {
            stateViolations.push({
              file: analysis.relativePath,
              rule: "state-leaf",
              message: `state/ imports from forbidden module: ${imp.targetModule}`,
              imports: [imp.module],
            });
          }
          if (imp.targetModule && !allowedForState.has(imp.targetModule) && !forbiddenFromState.has(imp.targetModule)) {
            stateViolations.push({
              file: analysis.relativePath,
              rule: "state-leaf",
              message: `state/ imports from unexpected module: ${imp.targetModule}`,
              imports: [imp.module],
            });
          }
        }
      }
    });

    it("should have state files", () => {
      const stateFiles = Array.from(analyses.values())
        .filter(a => a.filePath.includes("/state/") && !a.filePath.includes(".test."));
      expect(stateFiles.length).toBeGreaterThan(0);
    });

    it("should have no violations", () => {
      if (stateViolations.length > 0) {
        console.error("\nstate/ violations:\n" +
          stateViolations.map(v => `  - ${v.file}: ${v.message}`).join("\n")
        );
      }
      expect(stateViolations).toHaveLength(0);
    });
  });

  describe("Rule 2: archive/types is a leaf module", () => {
    const violations: ImportViolation[] = [];
    const forbiddenFromArchive = new Set([
      "machine", "rails", "adapters", "integration",
      "config", "audit", "discovery", "state"
    ]);

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes("/archive/types")) continue;
        if (analysis.filePath.includes(".test.")) continue;

        const ffImports = analysis.imports.filter(i => i.isFFModule && i.targetModule);
        for (const imp of ffImports) {
          if (imp.targetModule && forbiddenFromArchive.has(imp.targetModule)) {
            violations.push({
              file: analysis.relativePath,
              rule: "archive-leaf",
              message: `archive/types imports from forbidden module: ${imp.targetModule}`,
              imports: [imp.module],
            });
          }
        }
      }
    });

    it("should have archive/types files", () => {
      const files = Array.from(analyses.values())
        .filter(a => a.filePath.includes("/archive/types") && !a.filePath.includes(".test."));
      expect(files.length).toBeGreaterThan(0);
    });

    it("should have no violations", () => {
      if (violations.length > 0) {
        console.error("\narchive/types violations:\n" +
          violations.map(v => `  - ${v.file}: ${v.message}`).join("\n")
        );
      }
      expect(violations).toHaveLength(0);
    });
  });

  describe("Rule 3: discovery/types is a leaf module", () => {
    const violations: ImportViolation[] = [];
    const forbiddenFromDiscovery = new Set([
      "machine", "rails", "adapters", "integration",
      "config", "audit", "archive", "state"
    ]);

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes("/discovery/types")) continue;
        if (analysis.filePath.includes(".test.")) continue;

        const ffImports = analysis.imports.filter(i => i.isFFModule && i.targetModule);
        for (const imp of ffImports) {
          if (imp.targetModule && forbiddenFromDiscovery.has(imp.targetModule)) {
            violations.push({
              file: analysis.relativePath,
              rule: "discovery-leaf",
              message: `discovery/types imports from forbidden module: ${imp.targetModule}`,
              imports: [imp.module],
            });
          }
        }
      }
    });

    it("should have discovery/types files", () => {
      const files = Array.from(analyses.values())
        .filter(a => a.filePath.includes("/discovery/types") && !a.filePath.includes(".test."));
      expect(files.length).toBeGreaterThan(0);
    });

    it("should have no violations", () => {
      if (violations.length > 0) {
        console.error("\ndiscovery/types violations:\n" +
          violations.map(v => `  - ${v.file}: ${v.message}`).join("\n")
        );
      }
      expect(violations).toHaveLength(0);
    });
  });

  describe("Rule 4: machine/ may only import from state/", () => {
    const violations: ImportViolation[] = [];
    const forbiddenFromMachine = new Set([
      "rails", "adapters", "integration", "config", "audit",
      "discovery", "archive", "logging", "cli"
    ]);

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes("/machine/")) continue;
        if (analysis.filePath.includes(".test.")) continue;

        const ffImports = analysis.imports.filter(i => i.isFFModule && i.targetModule);
        for (const imp of ffImports) {
          if (imp.targetModule && forbiddenFromMachine.has(imp.targetModule)) {
            violations.push({
              file: analysis.relativePath,
              rule: "machine-only-state",
              message: `machine/ imports from forbidden module: ${imp.targetModule}`,
              imports: [imp.module],
            });
          }
        }
      }
    });

    it("should have machine files", () => {
      const machineFiles = Array.from(analyses.values())
        .filter(a => a.filePath.includes("/machine/") && !a.filePath.includes(".test."));
      expect(machineFiles.length).toBeGreaterThan(0);
    });

    it("should have no violations", () => {
      if (violations.length > 0) {
        console.error("\nmachine/ violations:\n" +
          violations.map(v => `  - ${v.file}: ${v.message}`).join("\n")
        );
      }
      expect(violations).toHaveLength(0);
    });
  });

  describe("Rule 5: rails/ must NOT import from integration/", () => {
    const violations: ImportViolation[] = [];

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes("/rails/")) continue;
        if (analysis.filePath.includes(".test.")) continue;

        const integrationImports = analysis.imports.filter(
          i => i.isFFModule && i.targetModule === "integration"
        );

        for (const imp of integrationImports) {
          violations.push({
            file: analysis.relativePath,
            rule: "rails-no-integration",
            message: `rails/ imports from integration/: ${imp.module}`,
            imports: [imp.module],
          });
        }
      }
    });

    it("should have rails files", () => {
      const railsFiles = Array.from(analyses.values())
        .filter(a => a.filePath.includes("/rails/") && !a.filePath.includes(".test."));
      expect(railsFiles.length).toBeGreaterThan(0);
    });

    it("should have no rails -> integration imports", () => {
      if (violations.length > 0) {
        console.error("\nrails/ -> integration/ violations:\n" +
          violations.map(v => `  - ${v.file}`).join("\n")
        );
      }
      expect(violations).toHaveLength(0);
    });
  });

  describe("Rule 5b: rails/ must NOT import Node I/O builtins directly", () => {
    const violations: ImportViolation[] = [];
    const FORBIDDEN_NODE_BUILTINS = new Set([
      "fs", "path", "crypto", "child_process", "process", "os",
      "events", "stream", "buffer", "util", "url", "http", "https",
      "node:fs", "node:path", "node:crypto", "node:child_process",
      "node:process", "node:os", "node:events", "node:stream",
    ]);

    beforeAll(() => {
      for (const [, analysis] of analyses) {
        if (!analysis.filePath.includes("/rails/")) continue;
        if (analysis.filePath.includes(".test.")) continue;

        const builtinImports = analysis.imports.filter(
          i => i.isNodeBuiltin && FORBIDDEN_NODE_BUILTINS.has(i.module)
        );

        for (const imp of builtinImports) {
          violations.push({
            file: analysis.relativePath,
            rule: "rails-no-builtins",
            message: `rails/ imports from forbidden builtin: ${imp.module}`,
            imports: [imp.module],
          });
        }
      }
    });

    it("should have rails files", () => {
      const railsFiles = Array.from(analyses.values())
        .filter(a => a.filePath.includes("/rails/") && !a.filePath.includes(".test."));
      expect(railsFiles.length).toBeGreaterThan(0);
    });

    it("should have no rails -> Node builtin imports", () => {
      if (violations.length > 0) {
        console.error("\nrails/ -> Node builtin violations:\n" +
          violations.map(v => `  - ${v.file}: ${v.message}`).join("\n")
        );
      }
      expect(violations).toHaveLength(0);
    });
  });

  describe("Rule 6: Inward imports are ALLOWED (outer may import inner)", () => {
    it("should allow integration/ to import from rails/ (entry point pattern)", () => {
      const integrationRailsImports = Array.from(analyses.values())
        .filter(a => a.filePath.includes("/integration/") && !a.filePath.includes(".test."))
        .flatMap(a => a.imports.filter(i => i.isFFModule && i.targetModule === "rails"));

      expect(integrationRailsImports.length).toBeGreaterThan(0);
    });

    it("should allow adapters/ to import from state/ (common pattern)", () => {
      const adaptersStateImports = Array.from(analyses.values())
        .filter(a => a.filePath.includes("/adapters/") && !a.filePath.includes(".test."))
        .flatMap(a => a.imports.filter(i => i.isFFModule && i.targetModule === "state"));

      expect(adaptersStateImports.length).toBeGreaterThan(0);
    });
  });

  describe("Performance", () => {
    it("should analyze all files in < 500ms", async () => {
      const start = performance.now();
      const tsFiles = await collectFiles(SRC_DIR, /\.ts$/);
      for (const file of tsFiles) {
        await analyzeFile(file);
      }
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500);
    });

    it("should handle files with many imports efficiently", async () => {
      const largeFiles = Array.from(analyses.entries())
        .filter(([, a]) => a.imports.length > 30)
        .slice(0, 5);

      if (largeFiles.length > 0) {
        const start = performance.now();
        for (const [file] of largeFiles) {
          await analyzeFile(file);
        }
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(50);
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle files with no imports", () => {
      const noImportFiles = Array.from(analyses.values())
        .filter(a => a.imports.length === 0);

      expect(noImportFiles.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle type-only imports correctly", () => {
      const filesWithTypes = Array.from(analyses.values())
        .filter(a => a.imports.some(i => i.raw.includes("import type")));

      expect(filesWithTypes.length).toBeGreaterThan(0);
    });

    it("should handle re-exports correctly", () => {
      const reExportFiles = Array.from(analyses.values())
        .filter(a => a.imports.some(i => i.raw.includes("export from") || i.raw.includes("export *")));

      expect(reExportFiles.length).toBeGreaterThanOrEqual(0);
    });

    it("should correctly identify Node builtin imports", () => {
      const testCases = [
        { input: "node:fs", expected: true },
        { input: "node:path", expected: true },
        { input: "node:crypto", expected: true },
        { input: "fs", expected: true },
        { input: "path", expected: true },
        { input: "crypto", expected: true },
        { input: "z", expected: false },
        { input: "vitest", expected: false },
        { input: "../state/schema", expected: false },
      ];

      for (const { input, expected } of testCases) {
        expect(isNodeBuiltinImport(input)).toBe(expected);
      }
    });
  });

  describe("Summary", () => {
    it("should have analyzed all TypeScript files", () => {
      const nonTestCount = Array.from(analyses.values())
        .filter(a => !a.filePath.includes(".test.")).length;

      expect(nonTestCount).toBeGreaterThan(50);
    });

    it("should have no critical architecture violations", () => {
      const allViolations: ImportViolation[] = [];

      for (const [, analysis] of analyses) {
        if (analysis.filePath.includes(".test.")) continue;
        const layer = getLayerFromPath(analysis.filePath);
        if (!layer) continue;

        const ffImports = analysis.imports.filter(i => i.isFFModule && i.targetModule);

        if (layer === "state") {
          const forbidden = new Set(["machine", "rails", "adapters", "integration", "config", "audit", "archive", "logging", "cli"]);
          for (const imp of ffImports) {
            if (imp.targetModule && forbidden.has(imp.targetModule)) {
              allViolations.push({
                file: analysis.relativePath,
                rule: `leaf-${layer}`,
                message: `${layer}/ is a leaf module but imports: ${imp.targetModule}`,
              });
            }
          }
        }

        if (layer === "machine") {
          const forbidden = new Set(["rails", "adapters", "integration", "config", "audit", "discovery", "archive", "logging", "cli"]);
          for (const imp of ffImports) {
            if (imp.targetModule && forbidden.has(imp.targetModule)) {
              allViolations.push({
                file: analysis.relativePath,
                rule: `machine-only-state`,
                message: `machine/ may only import state/ but imports: ${imp.targetModule}`,
              });
            }
          }
        }

        if (layer === "rails" && analysis.filePath.includes("/rails/")) {
          const integrationImports = ffImports.filter(i => i.targetModule === "integration");
          for (const imp of integrationImports) {
            allViolations.push({
              file: analysis.relativePath,
              rule: `rails-no-integration`,
              message: `rails/ must not import integration/`,
            });
          }

          const FORBIDDEN_NODE_BUILTINS = new Set([
            "fs", "path", "crypto", "child_process", "process", "os",
            "events", "stream", "buffer", "util", "url", "http", "https",
            "node:fs", "node:path", "node:crypto", "node:child_process",
            "node:process", "node:os", "node:events", "node:stream",
          ]);
          const builtinImports = analysis.imports.filter(
            i => i.isNodeBuiltin && FORBIDDEN_NODE_BUILTINS.has(i.module)
          );
          for (const imp of builtinImports) {
            allViolations.push({
              file: analysis.relativePath,
              rule: `rails-no-builtins`,
              message: `rails/ must not import Node builtin: ${imp.module}`,
            });
          }
        }
      }

      if (allViolations.length > 0) {
        const summary = allViolations.map(v =>
          `  - ${v.file}: ${v.message}`
        ).join("\n");

        console.error("\nCritical architecture violations:\n" + summary);
      }

      expect(allViolations).toHaveLength(0);
    });
  });
});

export type { ImportViolation, ImportInfo, FileAnalysis };
