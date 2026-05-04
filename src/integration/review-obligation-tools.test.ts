import { describe, expect, it } from 'vitest';
import { ReviewObligationType } from '../state/evidence.js';
import {
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_REVIEW,
} from './tool-names.js';
import {
  REVIEWABLE_TOOLS,
  isReviewableTool,
  obligationTypeForTool,
} from './review-obligation-tools.js';

describe('review-obligation-tools', () => {
  describe('HAPPY', () => {
    it('maps every reviewable tool to the canonical obligation type', () => {
      expect(obligationTypeForTool(TOOL_FLOWGUARD_PLAN)).toBe('plan');
      expect(obligationTypeForTool(TOOL_FLOWGUARD_IMPLEMENT)).toBe('implement');
      expect(obligationTypeForTool(TOOL_FLOWGUARD_ARCHITECTURE)).toBe('architecture');
    });
  });

  describe('BAD', () => {
    it('does not map non-reviewable tools', () => {
      expect(isReviewableTool(TOOL_FLOWGUARD_REVIEW)).toBe(false);
      expect(obligationTypeForTool(TOOL_FLOWGUARD_REVIEW)).toBeUndefined();
      expect(obligationTypeForTool('flowguard_unknown')).toBeUndefined();
    });
  });

  describe('CORNER', () => {
    it('reviewable tool list covers ReviewObligationType exactly once', () => {
      const obligationTypes = REVIEWABLE_TOOLS.map((tool) => obligationTypeForTool(tool)).sort();
      // 'review' obligation type is created by standalone /review (not a
      // reviewable tool), so it is intentionally absent from REVIEWABLE_TOOLS.
      const reviewableTypes = [...ReviewObligationType.options]
        .filter((type) => type !== 'review')
        .sort();
      expect(obligationTypes).toEqual(reviewableTypes);
    });
  });

  describe('EDGE', () => {
    it('reviewable tools are unique and type-guarded', () => {
      expect(new Set(REVIEWABLE_TOOLS).size).toBe(REVIEWABLE_TOOLS.length);
      for (const tool of REVIEWABLE_TOOLS) {
        expect(isReviewableTool(tool)).toBe(true);
      }
    });
  });
});
