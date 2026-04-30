/**
 * @test-policy
 * HAPPY: all tools are classified in TOOL_CLASSIFICATION.
 * HAPPY: workflow tools are correctly identified.
 * HAPPY: operational tools are correctly identified.
 * BAD: unclassified tool throws error.
 * CORNER: getToolClassification throws for unknown tool.
 * PERF: not applicable; pure functions.
 */
import { describe, expect, it } from 'vitest';
import {
  TOOL_CLASSIFICATION,
  getToolClassification,
  isWorkflowTool,
  isOperationalTool,
  listClassifiedTools,
  type ToolClassification,
} from './tool-classification.js';

describe('tool-classification', () => {
  describe('HAPPY — all known tools are classified', () => {
    it('hydrate is workflow', () => {
      expect(getToolClassification('hydrate')).toBe('workflow');
    });

    it('ticket is workflow', () => {
      expect(getToolClassification('ticket')).toBe('workflow');
    });

    it('plan is workflow', () => {
      expect(getToolClassification('plan')).toBe('workflow');
    });

    it('continue is workflow', () => {
      expect(getToolClassification('continue')).toBe('workflow');
    });

    it('validate is workflow', () => {
      expect(getToolClassification('validate')).toBe('workflow');
    });

    it('implement is workflow', () => {
      expect(getToolClassification('implement')).toBe('workflow');
    });

    it('review-decision is workflow', () => {
      expect(getToolClassification('review-decision')).toBe('workflow');
    });

    it('review is workflow', () => {
      expect(getToolClassification('review')).toBe('workflow');
    });

    it('architecture is workflow', () => {
      expect(getToolClassification('architecture')).toBe('workflow');
    });

    it('abort is workflow', () => {
      expect(getToolClassification('abort')).toBe('workflow');
    });

    it('status is operational', () => {
      expect(getToolClassification('status')).toBe('operational');
    });

    it('archive is operational', () => {
      expect(getToolClassification('archive')).toBe('operational');
    });

    it('doctor is operational', () => {
      expect(getToolClassification('doctor')).toBe('operational');
    });

    it('install is operational', () => {
      expect(getToolClassification('install')).toBe('operational');
    });
  });

  describe('HAPPY — helper functions work', () => {
    it('isWorkflowTool returns true for workflow tools', () => {
      expect(isWorkflowTool('plan')).toBe(true);
      expect(isWorkflowTool('archive')).toBe(false);
    });

    it('isOperationalTool returns true for operational tools', () => {
      expect(isOperationalTool('archive')).toBe(true);
      expect(isOperationalTool('plan')).toBe(false);
    });
  });

  describe('BAD — unclassified tool throws', () => {
    it('throws for unknown tool', () => {
      expect(() => getToolClassification('flowguard_unknown')).toThrow(
        'Unclassified tool: flowguard_unknown',
      );
    });
  });

  describe('CORNER — all tools are listed in registry', () => {
    it('TOOL_CLASSIFICATION has no undefined values', () => {
      const tools = Object.values(TOOL_CLASSIFICATION);
      for (const tool of tools) {
        expect(tool).not.toBeUndefined();
        expect(tool === 'workflow' || tool === 'operational').toBe(true);
      }
    });

    it('listClassifiedTools returns all tools', () => {
      const tools = listClassifiedTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((t: { tool: string; classification: ToolClassification }) => t.tool && t.classification)).toBe(true);
    });
  });
});
