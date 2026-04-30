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
  isOperationalTool,
  isWorkflowTool,
  listClassifiedTools,
  type ToolClassification,
  WORKFLOW_TOOL_TO_COMMAND,
} from './tool-classification.js';
import {
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_TICKET,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_VALIDATE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_DECISION,
  TOOL_FLOWGUARD_REVIEW,
  TOOL_FLOWGUARD_ABORT,
  TOOL_FLOWGUARD_STATUS,
  TOOL_FLOWGUARD_ARCHIVE,
} from './tool-names.js';
import * as ToolNames from './tool-names.js';
import { Command } from '../machine/commands.js';

describe('tool-classification', () => {
  describe('HAPPY — all known tools are classified', () => {
    it('TOOL_FLOWGUARD_HYDRATE is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_HYDRATE)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_TICKET is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_TICKET)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_PLAN is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_PLAN)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_VALIDATE is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_VALIDATE)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_IMPLEMENT is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_IMPLEMENT)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_DECISION is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_DECISION)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_REVIEW is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_REVIEW)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_ARCHITECTURE is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_ARCHITECTURE)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_ABORT is workflow', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_ABORT)).toBe('workflow');
    });

    it('TOOL_FLOWGUARD_STATUS is operational', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_STATUS)).toBe('operational');
    });

    it('TOOL_FLOWGUARD_ARCHIVE is operational', () => {
      expect(getToolClassification(TOOL_FLOWGUARD_ARCHIVE)).toBe('operational');
    });
  });

  describe('HAPPY — helper functions work', () => {
    it('isWorkflowTool returns true for workflow tools', () => {
      expect(isWorkflowTool(TOOL_FLOWGUARD_PLAN)).toBe(true);
      expect(isWorkflowTool(TOOL_FLOWGUARD_ARCHIVE)).toBe(false);
    });

    it('isOperationalTool returns true for operational tools', () => {
      expect(isOperationalTool(TOOL_FLOWGUARD_ARCHIVE)).toBe(true);
      expect(isOperationalTool(TOOL_FLOWGUARD_PLAN)).toBe(false);
    });

    it('helper predicates return false for unknown tools', () => {
      expect(isWorkflowTool('flowguard_unknown')).toBe(false);
      expect(isOperationalTool('flowguard_unknown')).toBe(false);
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
      expect(
        tools.every(
          (t: { tool: string; classification: ToolClassification }) => t.tool && t.classification,
        ),
      ).toBe(true);
    });

    it('all TOOL_FLOWGUARD_* names from tool-names.ts are classified', () => {
      const canonicalTools = Object.entries(ToolNames)
        .filter(([name]) => name.startsWith('TOOL_FLOWGUARD_'))
        .map(([, value]) => value);

      for (const tool of canonicalTools) {
        expect(() => getToolClassification(tool)).not.toThrow();
        const classification = getToolClassification(tool);
        expect(['workflow', 'operational']).toContain(classification);
      }
    });

    it('all workflow tools have a Command mapping', () => {
      for (const [tool, command] of Object.entries(WORKFLOW_TOOL_TO_COMMAND)) {
        expect(getToolClassification(tool)).toBe('workflow');
        expect(Object.values(Command)).toContain(command);
      }
    });

    it('maps architecture tool to Command.ARCHITECTURE', () => {
      expect(WORKFLOW_TOOL_TO_COMMAND[TOOL_FLOWGUARD_ARCHITECTURE]).toBe(Command.ARCHITECTURE);
    });
  });
});
