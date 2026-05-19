import { renderCommandGovernanceRules } from '../mandates-renderer.js';

/**
 * Temporary compatibility projection for command templates.
 *
 * The text is rendered from the mandates SSOT in `src/templates/mandates.ts`;
 * command templates must not copy semantic governance rules directly.
 */
export const GOVERNANCE_RULES = renderCommandGovernanceRules();
