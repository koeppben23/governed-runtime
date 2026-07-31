/**
 * @module integration/proofgraph/registration-consistency
 * @description Cross-artifact structural consistency for the command surface.
 *
 * Detects the "green CI but registries disagree" drift class: an installed
 * command interface whose template body is missing, whose target tool name is
 * not a registered FlowGuard tool, or whose workflow command is not a valid
 * machine command. Each is individually plausible in its own file yet mutually
 * inconsistent - exactly the contradiction ProofGraph makes visible.
 *
 * The evaluation is pure and dependency-injected so it is testable with seeded
 * inconsistencies; `checkRegistrationConsistency` binds the real registries.
 * Advisory: it produces findings, it does not gate.
 *
 * @version v1
 */

import { INSTALLED_COMMANDS } from '../installed-commands.js';
import { COMMANDS } from '../../templates/commands/index.js';
import { Command } from '../../machine/commands.js';
import { ALL_FLOWGUARD_TOOL_NAMES } from '../tool-names.js';

/** Which registration invariant a finding violated. */
export type RegistrationConsistencyRule =
  'template_body_present' | 'tool_name_registered' | 'workflow_command_valid';

/** A single detected registration inconsistency. */
export interface RegistrationConsistencyFinding {
  readonly rule: RegistrationConsistencyRule;
  readonly invocation: string;
  readonly detail: string;
}

/** Result of a registration-consistency evaluation. */
export interface RegistrationConsistencyReport {
  readonly ok: boolean;
  readonly checkedCommands: number;
  readonly findings: readonly RegistrationConsistencyFinding[];
}

/** Minimal view of an installed command required for the checks. */
export interface InstalledCommandView {
  readonly invocation: string;
  readonly templateFile: string;
  readonly target: { readonly toolName: string; readonly workflowCommand?: string };
}

/** Injected registries the evaluation is checked against. */
export interface RegistrationConsistencyInputs {
  readonly installedCommands: readonly InstalledCommandView[];
  /** Template files that have an installed body. */
  readonly templateFiles: ReadonlySet<string>;
  /** Registered FlowGuard tool names. */
  readonly toolNames: ReadonlySet<string>;
  /** Valid machine command names. */
  readonly workflowCommands: ReadonlySet<string>;
}

/**
 * Evaluate registration consistency over injected registries (pure).
 * Findings are emitted in a deterministic order (command order, then rule order).
 */
export function evaluateRegistrationConsistency(
  inputs: RegistrationConsistencyInputs,
): RegistrationConsistencyReport {
  const findings: RegistrationConsistencyFinding[] = [];
  for (const cmd of inputs.installedCommands) {
    if (!inputs.templateFiles.has(cmd.templateFile)) {
      findings.push({
        rule: 'template_body_present',
        invocation: cmd.invocation,
        detail: `no installed template body for ${cmd.templateFile}`,
      });
    }
    if (!inputs.toolNames.has(cmd.target.toolName)) {
      findings.push({
        rule: 'tool_name_registered',
        invocation: cmd.invocation,
        detail: `unregistered target tool name: ${cmd.target.toolName}`,
      });
    }
    const workflowCommand = cmd.target.workflowCommand;
    if (workflowCommand !== undefined && !inputs.workflowCommands.has(workflowCommand)) {
      findings.push({
        rule: 'workflow_command_valid',
        invocation: cmd.invocation,
        detail: `unknown workflow command: ${workflowCommand}`,
      });
    }
  }
  return { ok: findings.length === 0, checkedCommands: inputs.installedCommands.length, findings };
}

/** Evaluate registration consistency against the real, installed registries. */
export function checkRegistrationConsistency(): RegistrationConsistencyReport {
  return evaluateRegistrationConsistency({
    installedCommands: INSTALLED_COMMANDS.map((definition) => ({
      invocation: definition.invocation,
      templateFile: definition.templateFile,
      target: {
        toolName: definition.target.toolName,
        workflowCommand: definition.target.workflowCommand,
      },
    })),
    templateFiles: new Set(Object.keys(COMMANDS)),
    toolNames: ALL_FLOWGUARD_TOOL_NAMES,
    workflowCommands: new Set<string>(Object.values(Command)),
  });
}
