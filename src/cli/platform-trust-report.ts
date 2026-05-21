/**
 * @module cli/platform-trust-report
 * @description Projection-only host trust and capability diagnostics for doctor.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EnforcementLevel, HostCapabilities } from '../adapters/host-adapter.js';
import type { HostId } from '../shared/hosts.js';
import type { DoctorCheck, InstallScope } from './install-helpers.js';
import { codexInstallStatus, resolveCodexMarketplacePath } from './codex-plugin-install.js';

interface HostTrustProjection {
  enforcementLevel: EnforcementLevel;
  capabilities: HostCapabilities;
  runtimeVerification: string;
  activation: string;
  hookSemantics: string;
  approvalPrimitive: string;
  reviewerTransport: string;
  receiptPreservation: readonly string[];
}

const HOST_TRUST: Record<HostId, HostTrustProjection> = {
  opencode: {
    enforcementLevel: 'synchronous',
    capabilities: {
      preToolBlock: true,
      argMutation: true,
      outputReplacement: true,
      contextInjection: true,
      reviewerSpawn: true,
      compactionInjection: true,
    },
    runtimeVerification:
      'runtime probe required for Governance active; file existence is not proof',
    activation:
      'configured when local plugin artifacts and import check pass; restart still required',
    hookSemantics: 'in-process plugin can synchronously block through FlowGuard runtime decisions',
    approvalPrimitive: 'FlowGuard /review-decision with validated obligation-bound ReviewFindings',
    reviewerTransport: 'OpenCode subagent is transport/isolation only, not approval authority',
    receiptPreservation: [
      'sessionId: preserved by FlowGuard state/audit',
      'reviewDecisionId: preserved by FlowGuard decision receipt',
      'obligationId: preserved by FlowGuard review assurance state',
      'nativeHostApprovalId: not preserved by host transport',
    ],
  },
  'claude-code': {
    enforcementLevel: 'hook_gated',
    capabilities: {
      preToolBlock: true,
      argMutation: false,
      outputReplacement: false,
      contextInjection: true,
      reviewerSpawn: true,
      compactionInjection: true,
    },
    runtimeVerification:
      'NOT_VERIFIED_RUNTIME until Claude Code loads plugin and FlowGuard MCP/hooks report',
    activation:
      'configured means plugin tree exists; native plugin load is not inferred from files',
    hookSemantics:
      'PreToolUse can deny selected tool calls; PostToolUse contextualizes but does not rollback',
    approvalPrimitive: 'FlowGuard /review-decision with validated obligation-bound ReviewFindings',
    reviewerTransport: 'Claude Code agent is transport/isolation only, not approval authority',
    receiptPreservation: [
      'sessionId: preserved when FlowGuard MCP runtime receives host session context',
      'reviewDecisionId: preserved by FlowGuard decision receipt',
      'obligationId: preserved by FlowGuard review assurance state',
      'nativeHostApprovalId: not preserved by host transport',
    ],
  },
  codex: {
    enforcementLevel: 'hook_gated',
    capabilities: {
      preToolBlock: true,
      argMutation: true,
      outputReplacement: true,
      contextInjection: true,
      reviewerSpawn: true,
      compactionInjection: false,
    },
    runtimeVerification:
      'NOT_VERIFIED_RUNTIME and NOT_VERIFIED_NATIVE_LOAD until Codex loads plugin',
    activation: 'configured requires marketplace entry; native load still NOT_VERIFIED_NATIVE_LOAD',
    hookSemantics:
      '[features].plugin_hooks = true plus /hooks trust review required; PreToolUse is a Bash/apply_patch guardrail, not a complete security boundary',
    approvalPrimitive:
      'FlowGuard flowguard_decision with validated obligation-bound ReviewFindings',
    reviewerTransport: 'Codex subagent is transport/isolation only, not approval authority',
    receiptPreservation: [
      'sessionId: preserved when FlowGuard MCP runtime receives host session context',
      'reviewDecisionId: preserved by FlowGuard decision receipt',
      'obligationId: preserved by FlowGuard review assurance state',
      'nativeHostApprovalId: not preserved by host transport',
      'codexHookTrustPromptId: not preserved by host transport',
    ],
  },
};

export function buildPlatformTrustReport(
  host: HostId,
  scope: InstallScope,
  target: string,
): DoctorCheck[] {
  const projection = HOST_TRUST[host];
  const checks: DoctorCheck[] = [
    {
      file: `trust://${host}/authority`,
      status: 'warn',
      detail:
        'projection-only diagnostic; FlowGuard state, policy, audit, and review evidence remain canonical authorities',
    },
    {
      file: `trust://${host}/capabilities`,
      status: 'warn',
      detail: `enforcement=${projection.enforcementLevel}; capabilities=${JSON.stringify(projection.capabilities)}`,
    },
    {
      file: `trust://${host}/runtime`,
      status: 'warn',
      detail: projection.runtimeVerification,
    },
    {
      file: `trust://${host}/activation`,
      status: hostActivationStatus(host, scope, target),
      detail: projection.activation,
    },
    {
      file: `trust://${host}/approval-primitive`,
      status: 'warn',
      detail: projection.approvalPrimitive,
    },
    {
      file: `trust://${host}/reviewer-transport`,
      status: 'warn',
      detail: projection.reviewerTransport,
    },
    {
      file: `trust://${host}/hook-semantics`,
      status: 'warn',
      detail: projection.hookSemantics,
    },
  ];

  for (const receiptField of projection.receiptPreservation) {
    checks.push({
      file: `trust://${host}/receipt-preservation`,
      status: 'warn',
      detail: receiptField,
    });
  }

  if (host === 'codex') {
    checks.push({
      file: resolveCodexMarketplacePath(scope),
      status: codexInstallStatus(scope) === 'INSTALLED_AND_REGISTERED' ? 'warn' : 'missing',
      detail: `Codex marketplace registration: ${codexInstallStatus(scope)}; native load NOT_VERIFIED_NATIVE_LOAD`,
    });
  }

  return checks;
}

function hostActivationStatus(
  host: HostId,
  scope: InstallScope,
  target: string,
): DoctorCheck['status'] {
  if (host === 'opencode') return 'warn';
  if (host === 'claude-code') {
    return existsSync(join(target, 'flowguard-plugin', '.claude-plugin', 'plugin.json'))
      ? 'warn'
      : 'missing';
  }
  return codexInstallStatus(scope) === 'INSTALLED_AND_REGISTERED' ? 'warn' : 'missing';
}
