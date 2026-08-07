/**
 * @module discovery/verification-script-analysis
 * @description Provider-aware analysis of package.json script command strings.
 *
 * Detects which known assertion provider a script invokes by matching against
 * declarative ScriptSignatures from the provider catalog. Contains no provider
 * switches — all matching is driven by the catalog's signature descriptors.
 *
 * Conservative, fail-closed: compound shell commands, conflicting reporters,
 * and unrecognized tool invocations all produce non-enrichable results.
 *
 * @version v1
 */

import type { ProviderId } from '../state/assertion-identity.js';
import type { ScriptSignature } from '../providers/registry.js';
import type { VerificationCandidateKind } from '../state/discovery-schemas.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScriptAnalysis {
  readonly scriptName: string;
  readonly command: string;

  readonly provider:
    | {
        readonly status: 'identified';
        readonly providerId: ProviderId;
        readonly executionProfileId: string;
        readonly candidateKind: VerificationCandidateKind;
        readonly confidence: 'high' | 'medium';
        readonly evidence: string;
      }
    | {
        readonly status: 'unidentified';
      };

  readonly argumentForwarding: 'supported' | 'unsupported' | 'unknown';
  readonly reporterConfigurationPresent: boolean;
  readonly isCompound: boolean;
}

// ─── Unsafe shell patterns ──────────────────────────────────────────────────

/** Patterns that make a script unsafe for argument forwarding. */
const UNSAFE_SHELL_RE = /&&|\|\||[;&|]|\$\(|`/;

/** Arguments that indicate an already-configured reporter. */
const REPORTER_FLAGS = [
  /--reporter[=\s]/,
  /--json/,
  /--json-report/,
  /--outputFile[=\s]/,
  /--junitxml/,
];

/** Env var prefixes that can be safely stripped. */
const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*=[^\s]+/;

/** Package manager exec wrappers that can be safely stripped. */
const EXEC_PREFIXES = ['npx', 'pnpm exec', 'yarn exec', 'bunx'];

/**
 * Represents a tokenized script command view after prefix stripping.
 */
interface TokenizedCommand {
  readonly tokens: readonly string[];
  readonly viaExecPrefix: boolean;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function analyzeVerificationScript(
  scriptName: string,
  command: string,
  signatures: ReadonlyMap<ProviderId, readonly ScriptSignature[]>,
): ScriptAnalysis {
  const trimmed = command.trim();

  const isCompound = UNSAFE_SHELL_RE.test(trimmed);
  const reporterConfigurationPresent = checkExistingReporterConfig(trimmed);

  const base: Omit<ScriptAnalysis, 'provider'> = {
    scriptName,
    command: trimmed,
    argumentForwarding: isCompound ? 'unsupported' : 'supported',
    reporterConfigurationPresent,
    isCompound,
  };

  const tokenized = tokenize(trimmed);
  if (!tokenized) {
    return { ...base, provider: { status: 'unidentified' } };
  }

  const match = matchSignatures(tokenized.tokens, signatures);
  if (!match) {
    return { ...base, provider: { status: 'unidentified' } };
  }

  const confidence = match.viaModuleInvocation
    ? 'high'
    : tokenized.viaExecPrefix
      ? 'medium'
      : 'high';

  return {
    ...base,
    provider: {
      status: 'identified',
      providerId: match.providerId,
      executionProfileId: match.executionProfileId,
      candidateKind: match.candidateKind,
      confidence,
      evidence: match.evidence,
    },
  };
}

// ─── Tokenization ────────────────────────────────────────────────────────────

function tokenize(command: string): TokenizedCommand | null {
  let remaining = command.trim();

  // Strip cross-env: cross-env FOO=bar vitest run → vitest run
  while (remaining.startsWith('cross-env ')) {
    remaining = remaining.slice('cross-env '.length).trim();
    // Also consume env var settings after cross-env
    while (ENV_VAR_RE.test(remaining)) {
      remaining = remaining.replace(ENV_VAR_RE, '').trim();
    }
  }

  // Strip env var prefixes: FOO=bar vitest run → vitest run
  while (ENV_VAR_RE.test(remaining)) {
    remaining = remaining.replace(ENV_VAR_RE, '').trim();
  }

  // Detect exec prefixes
  let viaExecPrefix = false;
  for (const prefix of EXEC_PREFIXES) {
    if (remaining.startsWith(prefix + ' ')) {
      remaining = remaining.slice(prefix.length).trim();
      viaExecPrefix = true;
      break;
    }
  }

  const tokens = remaining.split(/\s+/);
  if (tokens.length === 0) return null;

  return { tokens, viaExecPrefix };
}

// ─── Signature Matching ──────────────────────────────────────────────────────

interface SignatureMatch {
  providerId: ProviderId;
  executionProfileId: string;
  candidateKind: VerificationCandidateKind;
  evidence: string;
  viaModuleInvocation: boolean;
}

function matchSignatures(
  tokens: readonly string[],
  signatures: ReadonlyMap<ProviderId, readonly ScriptSignature[]>,
): SignatureMatch | null {
  if (tokens.length === 0) return null;
  const firstToken = tokens[0]!;

  for (const [providerId, sigs] of signatures) {
    for (const sig of sigs) {
      if ('moduleInvocation' in sig) {
        const mi = sig.moduleInvocation;
        if (
          firstToken === mi.executable &&
          tokens.length >= 3 &&
          tokens[1] === '-m' &&
          tokens[2] === mi.module
        ) {
          return {
            providerId,
            executionProfileId: sig.executionProfileId,
            candidateKind: sig.candidateKind,
            evidence: `script:${mi.executable} -m ${mi.module}`,
            viaModuleInvocation: true,
          };
        }
        if (firstToken === mi.module) {
          return {
            providerId,
            executionProfileId: sig.executionProfileId,
            candidateKind: sig.candidateKind,
            evidence: `script:${mi.module}`,
            viaModuleInvocation: false,
          };
        }
        continue;
      }

      if (firstToken !== sig.executable) continue;

      if (sig.requiredArgsPrefix && sig.requiredArgsPrefix.length > 0) {
        const prefix = sig.requiredArgsPrefix;
        let matched = true;
        for (let i = 0; i < prefix.length; i++) {
          if (tokens[i + 1] !== prefix[i]) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        return {
          providerId,
          executionProfileId: sig.executionProfileId,
          candidateKind: sig.candidateKind,
          evidence: `script:${sig.executable} ${prefix.join(' ')}`,
          viaModuleInvocation: false,
        };
      }

      return {
        providerId,
        executionProfileId: sig.executionProfileId,
        candidateKind: sig.candidateKind,
        evidence: `script:${sig.executable}`,
        viaModuleInvocation: false,
      };
    }
  }

  return null;
}

// ─── Reporter Detection ──────────────────────────────────────────────────────

function checkExistingReporterConfig(command: string): boolean {
  const lower = command.toLowerCase();
  return REPORTER_FLAGS.some((re) => re.test(lower));
}
