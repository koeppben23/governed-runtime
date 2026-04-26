/**
 * @module discovery/collectors/languages/js-ecosystem
 * @description JS/TS ecosystem re-exports from stack-detection.ts.
 * @version v1
 */
export { 
  refineFromPackageManagerField, refineBuildToolFromLockfiles,
  addRootFirstBuildTools, firstRootEvidence, addRootFirstLanguageAndLintFacts,
  collectRootBasenames, extractFromPackageJson, extractFromTsConfig
} from '../stack-detection.js';
