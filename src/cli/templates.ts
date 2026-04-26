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
  REVIEWER_AGENT_FILENAME,
  OPENCODE_JSON_TEMPLATE,
  PACKAGE_JSON_TEMPLATE,
} from '../templates/index.js';
