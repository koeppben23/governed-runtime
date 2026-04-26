/**
 * Split stack-detection.ts using ts-morph AST with correct function removal.
 * v3 — uses ts-morph's native remove() for precise AST manipulation.
 */
import { Project, SyntaxKind } from 'ts-morph';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const collectorsDir = join(projectRoot, 'src/discovery/collectors');
const languagesDir = join(collectorsDir, 'languages');
const srcPath = join(collectorsDir, 'stack-detection.ts');

if (!existsSync(languagesDir)) mkdirSync(languagesDir, { recursive: true });

// Export map
const EXTRACTIONS: Record<string, string[]> = {
  'js-ecosystem.ts': [
    'refineFromPackageManagerField', 'refineBuildToolFromLockfiles',
    'collectRootBasenames', 'addRootFirstBuildTools', 'firstRootEvidence',
    'addRootFirstLanguageAndLintFacts', 'extractFromPackageJson', 'extractFromTsConfig',
  ],
  'node.ts': ['extractFromNodeVersionFiles'],
  'go.ts': ['extractFromGoMod'],
  'python.ts': ['extractFromPythonRootFiles', 'hasRequirementEntry'],
  'rust.ts': ['extractFromRustRootFiles'],
};

// Imports needed by each language file
const FILE_IMPORTS: Record<string, string> = {
  'js-ecosystem.ts': `import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection.js';
import { safeRead, findItem, setVersion } from '../stack-detection.js';
import { getRootBasename } from '../../repo-paths.js';
import { PACKAGE_MANAGER_RE, BUILD_TOOL_RULES } from '../stack-detection-rules.js';
import { LOCKFILE_RULES } from '../stack-detection.js';`,
  'node.ts': `import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection.js';
import { findItem, setVersion } from '../stack-detection.js';`,
  'go.ts': `import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection.js';
import { captureGroup, findItem, setVersion } from '../stack-detection.js';`,
  'python.ts': `import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection.js';
import { findItem, setVersion } from '../stack-detection.js';
import { PYTHON_REQUIREMENTS_FILES, PYTHON_ECOSYSTEM_PACKAGES } from '../stack-detection-rules.js';`,
  'rust.ts': `import type { DetectedItem } from '../../types.js';
import type { ReadFileFn } from '../stack-detection.js';
import { captureGroup, findItem, setVersion } from '../stack-detection.js';`,
};

// Step 1: Export shared utilities from main file
const src1 = new Project({ tsConfigFilePath: join(projectRoot, 'tsconfig.json') });
src1.addSourceFileAtPath(srcPath);
const srcFile1 = src1.getSourceFileOrThrow(srcPath);

const EXPORT_NAMES = [
  'safeRead', 'setVersion', 'setCompilerTarget', 'captureGroup', 'findItem',
  'collectRootBasenames', 'LOCKFILE_RULES',
];
for (const name of EXPORT_NAMES) {
  const fn = srcFile1.getFunction(name);
  if (fn && !fn.isExported()) fn.setIsExported(true);
}
// Export ReadFileFn type and LOCKFILE_RULES variable
const readFileFn = srcFile1.getTypeAlias('ReadFileFn');
if (readFileFn && !readFileFn.isExported()) readFileFn.setIsExported(true);
const lockfile = srcFile1.getVariableDeclaration('LOCKFILE_RULES');
if (lockfile && !lockfile.getVariableStatement()?.isExported()) {
  lockfile.getVariableStatement()?.setIsExported(true);
}

srcFile1.saveSync();
console.log('Exports added to main file');

// Step 2: For each language, create the file with ts-morph
for (const [filename, funcNames] of Object.entries(EXTRACTIONS)) {
  const moduleName = filename.replace('.ts', '');
  const targetPath = join(languagesDir, filename);
  
  // Create new file with imports
  const header = `/**
 * @module discovery/collectors/languages/${moduleName}
 * @description ${moduleName.replace(/-/g, ' ')} ecosystem detection — extracted from stack-detection.ts.
 * @version v1
 */

${FILE_IMPORTS[filename]}

`;
  
  // Copy function texts from original
  let fnTexts = '';
  for (const name of funcNames) {
    const fn = srcFile1.getFunction(name);
    if (fn) {
      const text = fn.getText();
      // Add export
      if (fn.isAsync()) {
        fnTexts += text.replace('async function', 'export async function') + '\n\n';
      } else {
        fnTexts += text.replace('function ', 'export function ') + '\n\n';
      }
    } else {
      console.log(`  WARNING: ${name} not found`);
    }
  }
  
  writeFileSync(targetPath, header + fnTexts, 'utf-8');
  console.log(`${filename}: ${funcNames.length} functions (${(header + fnTexts).split('\n').length} lines)`);
}

// Step 3: Reload project and remove extracted functions from main file
const src2 = new Project({ tsConfigFilePath: join(projectRoot, 'tsconfig.json') });
src2.addSourceFileAtPath(srcPath);
const srcFile2 = src2.getSourceFileOrThrow(srcPath);

for (const funcNames of Object.values(EXTRACTIONS)) {
  for (const name of funcNames) {
    const fn = srcFile2.getFunction(name);
    if (fn) {
      fn.remove();
      console.log(`  Removed: ${name}`);
    }
  }
}

// Step 4: Add imports for moved functions
const mainImports = [
  `import { refineFromPackageManagerField, refineBuildToolFromLockfiles, collectRootBasenames, addRootFirstBuildTools, firstRootEvidence, addRootFirstLanguageAndLintFacts, extractFromPackageJson, extractFromTsConfig } from './languages/js-ecosystem.js';`,
  `import { extractFromNodeVersionFiles } from './languages/node.js';`,
  `import { extractFromGoMod } from './languages/go.js';`,
  `import { extractFromPythonRootFiles, hasRequirementEntry } from './languages/python.js';`,
  `import { extractFromRustRootFiles } from './languages/rust.js';`,
];

for (const imp of mainImports.reverse()) {
  srcFile2.addImportDeclaration({ moduleSpecifier: imp.match(/from '(.+)'/)![1], namedImports: [] });
}
// Actually addImportDeclaration with namedImports is complex. Let me just insert text.

srcFile2.saveSync();

// Step 5: Manually add the import text after remove/save
let content = readFileSync(srcPath, 'utf-8');

const importBlock = `
// ─── Language-specific imports ──────────────────────────────────────────
import { refineFromPackageManagerField, refineBuildToolFromLockfiles, collectRootBasenames, addRootFirstBuildTools, firstRootEvidence, addRootFirstLanguageAndLintFacts, extractFromPackageJson, extractFromTsConfig } from './languages/js-ecosystem.js';
import { extractFromNodeVersionFiles } from './languages/node.js';
import { extractFromGoMod } from './languages/go.js';
import { extractFromPythonRootFiles, hasRequirementEntry } from './languages/python.js';
import { extractFromRustRootFiles } from './languages/rust.js';
`;

// Insert after the Java import
content = content.replace(
  "from './languages/java.js';",
  "from './languages/java.js';" + importBlock
);

writeFileSync(srcPath, content, 'utf-8');
console.log(`\nMain file: ${content.split('\n').length} lines`);
console.log('Done.');
