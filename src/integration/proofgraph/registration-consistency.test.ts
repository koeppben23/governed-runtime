/**
 * @module integration/proofgraph/registration-consistency.test
 * @description Cross-artifact registration consistency (#762): seeded-inconsistency
 * detection via DI, plus a live guard over the real installed registries.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRegistrationConsistency,
  checkRegistrationConsistency,
  type RegistrationConsistencyInputs,
} from './registration-consistency.js';

function inputs(over: Partial<RegistrationConsistencyInputs> = {}): RegistrationConsistencyInputs {
  return {
    installedCommands: [
      {
        invocation: '/plan',
        templateFile: 'plan.md',
        target: { toolName: 'flowguard_plan', workflowCommand: 'plan' },
      },
    ],
    templateFiles: new Set(['plan.md']),
    toolNames: new Set(['flowguard_plan']),
    workflowCommands: new Set(['plan']),
    ...over,
  };
}

describe('evaluateRegistrationConsistency', () => {
  it('reports ok for fully consistent registries', () => {
    const report = evaluateRegistrationConsistency(inputs());
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.checkedCommands).toBe(1);
  });

  it('detects a missing template body', () => {
    const report = evaluateRegistrationConsistency(inputs({ templateFiles: new Set() }));
    expect(report.ok).toBe(false);
    expect(report.findings[0]).toMatchObject({
      rule: 'template_body_present',
      invocation: '/plan',
    });
  });

  it('detects an unregistered target tool name', () => {
    const report = evaluateRegistrationConsistency(inputs({ toolNames: new Set() }));
    expect(report.findings.some((f) => f.rule === 'tool_name_registered')).toBe(true);
  });

  it('detects an unknown workflow command', () => {
    const report = evaluateRegistrationConsistency(inputs({ workflowCommands: new Set() }));
    expect(report.findings.some((f) => f.rule === 'workflow_command_valid')).toBe(true);
  });

  it('ignores the workflow-command rule when the target declares none', () => {
    const report = evaluateRegistrationConsistency(
      inputs({
        installedCommands: [
          {
            invocation: '/status',
            templateFile: 'status.md',
            target: { toolName: 'flowguard_status' },
          },
        ],
        templateFiles: new Set(['status.md']),
        toolNames: new Set(['flowguard_status']),
        workflowCommands: new Set(),
      }),
    );
    expect(report.ok).toBe(true);
  });

  it('emits findings in deterministic command-then-rule order', () => {
    const report = evaluateRegistrationConsistency(
      inputs({
        installedCommands: [
          {
            invocation: '/x',
            templateFile: 'x.md',
            target: { toolName: 'bad', workflowCommand: 'nope' },
          },
        ],
        templateFiles: new Set(),
        toolNames: new Set(),
        workflowCommands: new Set(),
      }),
    );
    expect(report.findings.map((f) => f.rule)).toEqual([
      'template_body_present',
      'tool_name_registered',
      'workflow_command_valid',
    ]);
  });
});

describe('checkRegistrationConsistency (live registries)', () => {
  it('the installed command surface is internally consistent', () => {
    const report = checkRegistrationConsistency();
    expect(report.checkedCommands).toBeGreaterThan(0);
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
  });
});
