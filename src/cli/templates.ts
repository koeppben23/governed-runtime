/**
 * @module templates
 *
 * Re-export facade for embedded templates used by the FlowGuard installer script.
 *
 * This module re-exports templates from src/templates/ to maintain backward
 * compatibility with existing import sites.
 */

export {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  MANDATES_FILENAME,
  mandatesInstructionEntry,
  LEGACY_INSTRUCTION_ENTRY,
  FLOWGUARD_MANDATES_BODY,
  buildMandatesContent,
  extractManagedDigest,
  extractManagedVersion,
  isManagedArtifact,
  extractManagedBody,
  REVIEWER_AGENT,
  CLAUDE_REVIEWER_AGENT,
  CODEX_REVIEWER_SUBAGENT,
  REVIEWER_AGENT_FILENAME,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
  CLAUDE_CODE_PLUGIN_DIR,
  CLAUDE_CODE_PLUGIN_RELATIVE_FILES,
  claudeCodePluginFiles,
  CODEX_PLUGIN_NAME,
  CODEX_PLUGIN_RELATIVE_FILES,
  codexPluginFiles,
} from '../templates/index.js';
