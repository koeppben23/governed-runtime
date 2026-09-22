#!/usr/bin/env node
/**
 * Standalone offline verifier for a FlowGuard evidence package and for the
 * demo evidence manifest that binds the three demo sessions to their external
 * host chat exports.
 *
 * A receiving auditor typically has only the package (a `.tar.gz`), the demo
 * evidence manifest, and the matching FlowGuard runtime — not the originating
 * session workspace, the OpenCode config directory, or network access. This
 * verifier therefore never reads the live session: it snapshots the package
 * into a private copy, extracts that copy, validates the embedded manifest
 * against the canonical schema, recomputes every covered digest with the
 * canonical primitives from `@flowguard/core`, and verifies the archived audit
 * chain offline. For regulated packages it validates the archived
 * regulated-completion evidence instead of assuming the live
 * `regulatedArchiveStatus` (the immutable archive necessarily snapshots the
 * status before verification completes).
 *
 * Explicit scope (never overclaim):
 * - Session identity is checked against `--expect-session` on the package's
 *   own records, so a valid package of a DIFFERENT session fails even when
 *   every internal hash matches.
 * - Raw packages are fully verified as defined below. Redacted sharing
 *   archives are not fully verifiable raw evidence and are only accepted with
 *   `--expect-sharing`, labelled `integrityCapability: not_verifiable`.
 * - Offline limits: TSA tokens are not cryptographically validated (no trust
 *   anchors/network), and the external archive-publication binding against
 *   the originating session audit trail cannot be reproduced from the package
 *   alone. See `EVIDENCE_PACKAGE.md`.
 * - The manifest is not signed. Internal consistency does not prove
 *   authenticity; an external trusted hash or signature is required for that.
 * - Host chat exports listed in the evidence manifest are supplementary
 *   evidence, never FlowGuard authority.
 *
 * Usage:
 *   node verify-evidence-package.mjs <package.tar.gz> --expect-session <id>
 *        [--expect-flow development|architecture|peer-review|regulated]
 *        [--expect-phase <PHASE>] [--expect-sharing] [--json]
 *   node verify-evidence-package.mjs --manifest <evidence-manifest.json> [--json]
 *
 * Exit codes (package mode): 0 = verified raw package, 1 = verification
 *   failed, 2 = usage/runtime error, 3 = sharing archive (not fully verifiable).
 * Exit codes (manifest mode): 0 = verified, 1 = verification failed,
 *   2 = usage/runtime error.
 *
 * @version v2
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TAR_TIMEOUT_MS = 30_000;
const MANIFEST_FILE = 'archive-manifest.json';
const STATE_FILE = 'state/session-state.json';
const AUDIT_FILE = 'audit/audit.jsonl';
const SHA256_HEX = /^[a-f0-9]{64}$/i;
const EVIDENCE_MANIFEST_SCHEMA_VERSION = 'demo-evidence-manifest.v1';
const EVIDENCE_MANIFEST_FLOWS = ['architecture', 'development', 'peer-review'];
const EVIDENCE_ARTIFACT_KINDS = ['flowguard-package', 'host-chat-export'];

const EXIT = Object.freeze({ verified: 0, failed: 1, usage: 2, sharing: 3 });

const FLOW_ALLOWED_PHASES = Object.freeze({
  development: ['EXPORT_READY', 'COMPLETE'],
  architecture: ['ARCH_COMPLETE'],
  'peer-review': ['PEER_REVIEW_COMPLETE'],
  regulated: ['COMPLETE'],
});

const KNOWN_TERMINAL_PHASES = Object.freeze([
  'EXPORT_READY',
  'COMPLETE',
  'ARCH_COMPLETE',
  'PEER_REVIEW_COMPLETE',
]);

function usage() {
  return [
    'Usage: node verify-evidence-package.mjs <package.tar.gz> --expect-session <id>',
    '           [--expect-flow development|architecture|peer-review|regulated]',
    '           [--expect-phase <PHASE>] [--expect-sharing] [--json]',
    '       node verify-evidence-package.mjs --manifest <evidence-manifest.json> [--json]',
    '',
    'Verifies a FlowGuard evidence package offline against the canonical',
    'manifest schema, the canonical content digest, the archived audit chain,',
    'and the archived regulated-completion evidence; or verifies the demo',
    'evidence manifest binding the three sessions to their host chat exports.',
    'Exit codes: 0 verified, 1 failed, 2 usage, 3 sharing archive.',
  ].join('\n');
}

function fail(message) {
  process.stderr.write(`verify-evidence-package: ${message}\n`);
  process.exit(EXIT.usage);
}

function parseArgs(argv) {
  const options = {
    packagePath: null,
    manifestPath: null,
    expectSession: null,
    expectFlow: null,
    expectPhase: null,
    expectSharing: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(EXIT.verified);
    }
    if (arg === '--manifest') {
      options.manifestPath = argv[++index] ?? null;
      if (!options.manifestPath) fail('--manifest requires a value');
      continue;
    }
    if (arg === '--expect-session') {
      options.expectSession = argv[++index] ?? null;
      if (!options.expectSession) fail('--expect-session requires a value');
      continue;
    }
    if (arg === '--expect-flow') {
      options.expectFlow = argv[++index] ?? null;
      if (!options.expectFlow) fail('--expect-flow requires a value');
      continue;
    }
    if (arg === '--expect-phase') {
      options.expectPhase = argv[++index] ?? null;
      if (!options.expectPhase) fail('--expect-phase requires a value');
      continue;
    }
    if (arg === '--expect-sharing') {
      options.expectSharing = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg.startsWith('-')) fail(`unknown option '${arg}'`);
    if (options.packagePath !== null) fail('exactly one package path is supported');
    options.packagePath = arg;
  }
  if (options.manifestPath !== null) {
    if (options.packagePath !== null) fail('--manifest cannot be combined with a package path');
    if (
      options.expectSession !== null ||
      options.expectFlow !== null ||
      options.expectPhase !== null
    ) {
      fail('package expectation flags cannot be combined with --manifest');
    }
    if (options.expectSharing) fail('--expect-sharing cannot be combined with --manifest');
    return options;
  }
  if (options.packagePath === null) fail('a package path or --manifest is required');
  if (options.expectSession === null) fail('--expect-session is required');
  if (options.expectFlow !== null && !Object.hasOwn(FLOW_ALLOWED_PHASES, options.expectFlow)) {
    fail(`--expect-flow must be one of: ${Object.keys(FLOW_ALLOWED_PHASES).join(', ')}`);
  }
  return options;
}

async function loadCore() {
  try {
    return await import('@flowguard/core');
  } catch (error) {
    fail(
      'cannot load @flowguard/core. Install the FlowGuard version that produced the ' +
        `package and run this verifier from that checkout (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function finding(list, code, message, file) {
  list.push({ code, severity: 'error', message, ...(file ? { file } : {}) });
}

function isSafeRelativePath(relativePath) {
  return (
    relativePath.length > 0 &&
    !path.posix.isAbsolute(relativePath) &&
    !relativePath.includes('\\') &&
    !relativePath
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

// ─── Package snapshot ────────────────────────────────────────────────────────

/**
 * Copy the package into a private snapshot before any byte is inspected, so
 * checksum, member inspection, and extraction always operate on one immutable
 * version (the product verifier does the same through `snapshotArchive()`).
 */
async function snapshotPackage(packagePath) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-evidence-snapshot-'));
  const snapshotPath = path.join(directory, path.basename(packagePath));
  await fs.copyFile(packagePath, snapshotPath);
  return {
    path: snapshotPath,
    cleanup: async () => {
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

// ─── Tar inspection ──────────────────────────────────────────────────────────

async function tarMembers(packagePath) {
  const [{ stdout: names }, { stdout: details }] = await Promise.all([
    execFileAsync('tar', ['-tzf', packagePath], { timeout: TAR_TIMEOUT_MS }),
    execFileAsync('tar', ['-tvzf', packagePath], { timeout: TAR_TIMEOUT_MS }),
  ]);
  const members = names.split(/\r?\n/).filter(Boolean);
  const memberDetails = details.split(/\r?\n/).filter(Boolean);
  if (memberDetails.some((detail) => !detail.startsWith('-'))) {
    return { members, nonRegular: true };
  }
  return { members, nonRegular: false };
}

async function extractPackage(packagePath, findings) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-evidence-verify-'));
  try {
    await execFileAsync('tar', ['-xzf', packagePath, '-C', root], { timeout: TAR_TIMEOUT_MS });
    return root;
  } catch (error) {
    finding(
      findings,
      'manifest_parse_error',
      `Archive extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await fs.rm(root, { recursive: true, force: true });
    return null;
  }
}

// ─── Package checks ──────────────────────────────────────────────────────────

async function verifyChecksum(snapshotPath, sourcePath, findings) {
  let sidecarContent = null;
  try {
    sidecarContent = await fs.readFile(`${sourcePath}.sha256`, 'utf-8');
  } catch {
    sidecarContent = null;
  }
  if (sidecarContent === null) {
    finding(findings, 'archive_checksum_missing', 'Archive checksum sidecar (.sha256) not found');
    return;
  }
  const tokens = sidecarContent.trim().split(/\s+/).filter(Boolean);
  const expected = tokens[0];
  if (
    !expected ||
    !SHA256_HEX.test(expected) ||
    tokens.filter((t) => SHA256_HEX.test(t)).length !== 1
  ) {
    finding(
      findings,
      'archive_checksum_mismatch',
      'Checksum sidecar is malformed; expected exactly one SHA-256 digest',
    );
    return;
  }
  const actual = await sha256File(snapshotPath);
  if (actual !== expected.toLowerCase()) {
    finding(
      findings,
      'archive_checksum_mismatch',
      `Archive checksum mismatch: sidecar says ${expected.slice(0, 12)}..., actual is ${actual.slice(0, 12)}...`,
    );
  }
}

function checkMemberInventory(members, includedFiles, sessionPrefix, findings) {
  const expected = new Set([
    `${sessionPrefix}/${MANIFEST_FILE}`,
    ...includedFiles.map((file) => `${sessionPrefix}/${file}`),
  ]);
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member)) {
      finding(findings, 'unexpected_file', `Archive contains duplicate member: ${member}`);
      continue;
    }
    seen.add(member);
    if (!member.startsWith(`${sessionPrefix}/`)) {
      finding(
        findings,
        'unexpected_file',
        `Archive member is outside the session prefix: ${member}`,
      );
      continue;
    }
    if (!isSafeRelativePath(member.slice(sessionPrefix.length + 1))) {
      finding(findings, 'unexpected_file', `Archive member path is unsafe: ${member}`);
      continue;
    }
    if (!expected.has(member)) {
      finding(findings, 'unexpected_file', `File not listed in manifest: ${member}`);
    }
  }
  for (const member of expected) {
    if (!seen.has(member)) {
      finding(findings, 'missing_file', `File listed in manifest is missing: ${member}`);
    }
  }
}

async function verifyRawPayloads(extractedRoot, manifest, findings) {
  for (const relativePath of manifest.includedFiles) {
    const fullPath = path.join(extractedRoot, relativePath);
    let content;
    try {
      content = await fs.readFile(fullPath);
    } catch {
      finding(
        findings,
        'missing_file',
        `File listed in manifest is missing: ${relativePath}`,
        relativePath,
      );
      continue;
    }
    const expected = manifest.fileDigests[relativePath];
    if (expected && sha256(content) !== expected) {
      finding(
        findings,
        'file_digest_mismatch',
        `File digest mismatch for ${relativePath}: expected ${expected.slice(0, 12)}..., got ${sha256(content).slice(0, 12)}...`,
        relativePath,
      );
    }
  }
}

function verifyContentDigest(core, manifest, findings) {
  let computed = null;
  try {
    computed = core.computeArchiveContentDigest({
      includedFiles: manifest.includedFiles,
      fileDigests: manifest.fileDigests,
      policyMode: manifest.policyMode,
      auditChainHead: manifest.auditChainHead,
      auditEventCount: manifest.auditEventCount,
      schemaVersion: manifest.schemaVersion,
      layoutVersion: manifest.layoutVersion,
      sessionId: manifest.sessionId,
      fingerprint: manifest.fingerprint,
      discoveryDigest: manifest.discoveryDigest,
    });
  } catch (error) {
    finding(
      findings,
      'content_digest_mismatch',
      `Content digest could not be computed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (computed !== manifest.contentDigest) {
    finding(
      findings,
      'content_digest_mismatch',
      'Content digest does not match the computed value from file digests and integrity header',
    );
  }
}

async function readArchivedState(core, extractedRoot, findings) {
  const statePath = path.join(extractedRoot, STATE_FILE);
  let raw;
  try {
    raw = await fs.readFile(statePath, 'utf-8');
  } catch {
    finding(findings, 'state_missing', 'Session state file not found', STATE_FILE);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    finding(findings, 'state_invalid', 'Session state file is not valid JSON', STATE_FILE);
    return null;
  }
  const result = core.SessionState.safeParse(parsed);
  if (!result.success) {
    finding(
      findings,
      'state_invalid',
      `Session state file does not satisfy the canonical schema: ${result.error.message}`,
      STATE_FILE,
    );
    return null;
  }
  return result.data;
}

function verifyIdentity(expectations, manifest, state, findings) {
  if (manifest.sessionId !== expectations.expectSession) {
    finding(
      findings,
      'session_identity_mismatch',
      `Package belongs to session '${manifest.sessionId}', expected '${expectations.expectSession}'`,
      MANIFEST_FILE,
    );
  }
  if (state === null) return;
  // manifest.sessionId is the host (OpenCode) session id; the archived state
  // binds it through binding.hostSessionId. flowguardSessionId is the separate
  // FlowGuard UUID and is used for audit-chain identity only.
  if (state?.binding?.hostSessionId !== manifest.sessionId) {
    finding(
      findings,
      'state_identity_mismatch',
      `Archived state host session '${String(state?.binding?.hostSessionId)}' does not match manifest session '${manifest.sessionId}'`,
      STATE_FILE,
    );
  }
  if (state?.binding?.fingerprint !== manifest.fingerprint) {
    finding(
      findings,
      'state_identity_mismatch',
      'Archived state fingerprint does not match the manifest fingerprint',
      STATE_FILE,
    );
  }
  if (state?.policySnapshot?.mode !== manifest.policyMode) {
    finding(
      findings,
      'manifest_policy_mode_mismatch',
      `Manifest policyMode '${manifest.policyMode}' does not match governed state mode '${String(state?.policySnapshot?.mode)}'`,
      MANIFEST_FILE,
    );
  }
}

function verifyFlowAndPhase(expectations, state, findings) {
  if (state === null) return null;
  const phase = state.phase;
  if (typeof phase !== 'string') {
    finding(findings, 'state_invalid', 'Archived state has no phase', STATE_FILE);
    return null;
  }
  const flow = expectations.expectFlow;
  if (flow !== null && !FLOW_ALLOWED_PHASES[flow].includes(phase)) {
    finding(
      findings,
      'flow_mismatch',
      `Package phase '${phase}' is not valid for flow '${flow}' (allowed: ${FLOW_ALLOWED_PHASES[flow].join(', ')})`,
      STATE_FILE,
    );
  }
  if (expectations.expectPhase !== null && phase !== expectations.expectPhase) {
    finding(
      findings,
      'phase_mismatch',
      `Package phase '${phase}' does not match expected '${expectations.expectPhase}'`,
      STATE_FILE,
    );
  }
  if (
    expectations.expectPhase === null &&
    flow === null &&
    !KNOWN_TERMINAL_PHASES.includes(phase)
  ) {
    finding(
      findings,
      'phase_mismatch',
      `Package phase '${phase}' is not a known export/terminal phase; pass --expect-phase for a deliberate expectation`,
      STATE_FILE,
    );
  }
  if (KNOWN_TERMINAL_PHASES.includes(phase)) {
    if (state?.transition?.to !== phase) {
      finding(
        findings,
        'phase_mismatch',
        `Archived state transition target '${String(state?.transition?.to)}' does not match phase '${phase}'`,
        STATE_FILE,
      );
    }
    if (
      phase === 'COMPLETE' &&
      !(
        state?.transition?.from === 'EXPORT_READY' &&
        state?.transition?.event === 'EXPORT_MATERIALIZED'
      )
    ) {
      finding(
        findings,
        'phase_mismatch',
        'COMPLETE export package must carry the EXPORT_READY -> COMPLETE (EXPORT_MATERIALIZED) transition',
        STATE_FILE,
      );
    }
  }
  if (state.error !== null && state.error !== undefined) {
    finding(
      findings,
      'state_invalid',
      `Archived state carries an error projection (${String(state?.error?.code)})`,
      STATE_FILE,
    );
  }
  return phase;
}

async function readAuditEvents(extractedRoot, findings) {
  const auditPath = path.join(extractedRoot, AUDIT_FILE);
  let raw;
  try {
    raw = await fs.readFile(auditPath, 'utf-8');
  } catch {
    finding(findings, 'missing_file', 'Audit trail file not found', AUDIT_FILE);
    return null;
  }
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      finding(
        findings,
        'audit_chain_invalid_event',
        'Audit trail contains a record that is not valid JSON',
        AUDIT_FILE,
      );
      return null;
    }
  }
  return events;
}

function verifyAuditChain(core, manifest, state, events, findings) {
  if (events === null) return;
  if (events.length !== manifest.auditEventCount) {
    finding(
      findings,
      'audit_chain_truncated',
      `Audit trail does not match manifest anchor: expected ${manifest.auditEventCount} event(s), found ${events.length}`,
      AUDIT_FILE,
    );
  }
  const chain = core.verifyChain(events, {
    ...(typeof state?.flowguardSessionId === 'string'
      ? { expectedFlowguardSessionId: state.flowguardSessionId }
      : {}),
  });
  if (!chain.valid) {
    const first = chain.firstBreak ?? chain.results?.find((entry) => entry.valid === false);
    finding(
      findings,
      'audit_chain_invalid',
      `Archived audit chain is invalid (${String(first?.reasonCode ?? chain.reason ?? 'unknown')}): ${String(first?.reason ?? '')}`,
      AUDIT_FILE,
    );
  }
  const actualHead = core.getLastChainHash(events);
  if (actualHead !== manifest.auditChainHead) {
    finding(
      findings,
      'audit_chain_truncated',
      `Audit chain head ${String(actualHead).slice(0, 12)}... does not match manifest anchor ${String(manifest.auditChainHead).slice(0, 12)}...`,
      AUDIT_FILE,
    );
  }
}

function verifyRegulatedCompletionEvidence(core, state, events, findings) {
  if (typeof core.verifyRegulatedCompletionCompleteness !== 'function') {
    finding(
      findings,
      'state_invalid',
      'The loaded @flowguard/core does not provide verifyRegulatedCompletionCompleteness; use the matching runtime version',
      STATE_FILE,
    );
    return;
  }
  if (events === null) return;
  core.verifyRegulatedCompletionCompleteness(state, events, findings);
}

/**
 * Verify one package. The caller owns output and exit-code decisions; the
 * returned findings are the canonical error list.
 */
async function verifyPackage(packagePath, expectations, core) {
  const findings = [];
  const snapshot = await snapshotPackage(packagePath);
  try {
    await verifyChecksum(snapshot.path, packagePath, findings);

    let members = [];
    let nonRegular = false;
    try {
      ({ members, nonRegular } = await tarMembers(snapshot.path));
    } catch (error) {
      finding(
        findings,
        'manifest_parse_error',
        `Archive members could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (nonRegular) {
      finding(findings, 'unexpected_file', 'Archive contains a non-regular member');
    }

    const manifestMember = members.find((member) => member.endsWith(`/${MANIFEST_FILE}`));
    const sessionPrefix = manifestMember
      ? manifestMember.slice(0, -1 * (MANIFEST_FILE.length + 1))
      : null;
    if (sessionPrefix === null) {
      finding(findings, 'missing_manifest', 'Archive manifest not found in the package');
    } else if (!isSafeRelativePath(sessionPrefix)) {
      finding(findings, 'unexpected_file', `Archive session prefix is unsafe: ${sessionPrefix}`);
    } else if (sessionPrefix !== expectations.expectSession) {
      finding(
        findings,
        'session_identity_mismatch',
        `Package belongs to session '${sessionPrefix}', expected '${expectations.expectSession}'`,
        MANIFEST_FILE,
      );
    }

    // Member-policy gate BEFORE extraction: an unsafe prefix, unsafe member
    // path, non-regular entry, or duplicate member is never extracted into the
    // temporary directory. The verifier never relies on `tar` itself rejecting
    // a traversal path.
    let extractionAllowed =
      sessionPrefix !== null &&
      isSafeRelativePath(sessionPrefix) &&
      !nonRegular &&
      new Set(members).size === members.length;
    if (extractionAllowed) {
      for (const member of members) {
        const relativePath = member.startsWith(`${sessionPrefix}/`)
          ? member.slice(sessionPrefix.length + 1)
          : null;
        if (relativePath === null || !isSafeRelativePath(relativePath)) {
          extractionAllowed = false;
          break;
        }
      }
    }
    if (sessionPrefix !== null && !extractionAllowed) {
      finding(
        findings,
        'unexpected_file',
        'Archive member policy violation: refusing to extract the package',
      );
    }

    const extractedRoot = extractionAllowed ? await extractPackage(snapshot.path, findings) : null;
    const sessionRoot =
      extractedRoot !== null && sessionPrefix !== null
        ? path.join(extractedRoot, sessionPrefix)
        : null;

    let manifest = null;
    if (sessionRoot !== null) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(sessionRoot, MANIFEST_FILE), 'utf-8'));
        const parsed = core.ArchiveManifestSchema.safeParse(raw);
        if (!parsed.success) {
          finding(
            findings,
            'manifest_parse_error',
            `Manifest schema validation failed: ${parsed.error.message}`,
            MANIFEST_FILE,
          );
        } else {
          manifest = parsed.data;
        }
      } catch (error) {
        finding(
          findings,
          'manifest_parse_error',
          `Manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          MANIFEST_FILE,
        );
      }
    }

    let phase = null;
    let classification = 'raw';
    if (manifest !== null && sessionRoot !== null) {
      checkMemberInventory(members, manifest.includedFiles, sessionPrefix, findings);
      const rawIncluded = manifest.rawIncluded === true;
      const hasState = members.includes(`${sessionPrefix}/${STATE_FILE}`);
      const hasAudit = members.includes(`${sessionPrefix}/${AUDIT_FILE}`);
      classification = rawIncluded && hasState && hasAudit ? 'raw' : 'sharing';

      if (classification === 'raw') {
        await verifyRawPayloads(sessionRoot, manifest, findings);
        verifyContentDigest(core, manifest, findings);
        const state = await readArchivedState(core, sessionRoot, findings);
        verifyIdentity(expectations, manifest, state, findings);
        phase = verifyFlowAndPhase(expectations, state, findings);
        const events = await readAuditEvents(sessionRoot, findings);
        verifyAuditChain(core, manifest, state, events, findings);
        verifyRegulatedCompletionEvidence(core, state, events, findings);
      } else if (!expectations.expectSharing) {
        finding(
          findings,
          'sharing_archive_not_verifiable',
          'Redacted sharing archive is not fully verifiable raw evidence; pass --expect-sharing to accept the limited structural checks',
          MANIFEST_FILE,
        );
      } else {
        await verifyRawPayloads(sessionRoot, manifest, findings);
        verifyIdentity(expectations, manifest, null, findings);
      }
    }

    if (extractedRoot !== null) {
      await fs.rm(extractedRoot, { recursive: true, force: true });
    }

    return { findings, classification, sessionId: manifest?.sessionId ?? sessionPrefix, phase };
  } finally {
    await snapshot.cleanup();
  }
}

// ─── Evidence manifest ───────────────────────────────────────────────────────

function validateEvidenceManifest(raw, findings) {
  if (raw === null || typeof raw !== 'object') {
    finding(findings, 'manifest_parse_error', 'Evidence manifest must be a JSON object');
    return null;
  }
  if (raw.schemaVersion !== EVIDENCE_MANIFEST_SCHEMA_VERSION) {
    finding(
      findings,
      'manifest_parse_error',
      `Evidence manifest schemaVersion must be '${EVIDENCE_MANIFEST_SCHEMA_VERSION}'`,
    );
    return null;
  }
  if (!Array.isArray(raw.sessions)) {
    finding(findings, 'manifest_parse_error', 'Evidence manifest sessions must be an array');
    return null;
  }
  const byFlow = new Map();
  for (const session of raw.sessions) {
    const flow = session?.flow;
    if (!EVIDENCE_MANIFEST_FLOWS.includes(flow)) {
      finding(
        findings,
        'manifest_parse_error',
        `Evidence manifest flow '${String(flow)}' must be one of: ${EVIDENCE_MANIFEST_FLOWS.join(', ')}`,
      );
      continue;
    }
    if (byFlow.has(flow)) {
      finding(findings, 'manifest_parse_error', `Evidence manifest declares flow '${flow}' twice`);
      continue;
    }
    if (typeof session?.sessionId !== 'string' || session.sessionId.length === 0) {
      finding(
        findings,
        'manifest_parse_error',
        `Evidence manifest flow '${flow}' has no sessionId`,
      );
      continue;
    }
    if (!Array.isArray(session.artifacts) || session.artifacts.length === 0) {
      finding(
        findings,
        'manifest_parse_error',
        `Evidence manifest flow '${flow}' has no artifacts`,
      );
      continue;
    }
    const chatExports = session.artifacts.filter((a) => a?.kind === 'host-chat-export');
    if (chatExports.length !== 1) {
      finding(
        findings,
        'manifest_parse_error',
        `Evidence manifest flow '${flow}' must declare exactly one host-chat-export; found ${chatExports.length}`,
      );
    }
    byFlow.set(flow, session);
  }
  for (const flow of EVIDENCE_MANIFEST_FLOWS) {
    if (!byFlow.has(flow)) {
      finding(findings, 'manifest_parse_error', `Evidence manifest is missing flow '${flow}'`);
    }
  }
  return byFlow;
}

async function verifyEvidenceManifest(manifestPath, core) {
  const findings = [];
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifestDir = path.dirname(resolvedManifestPath);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(resolvedManifestPath, 'utf-8'));
  } catch (error) {
    finding(
      findings,
      'manifest_parse_error',
      `Evidence manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { findings, sessions: [] };
  }
  const byFlow = validateEvidenceManifest(raw, findings);

  const declared = [];
  if (byFlow !== null) {
    for (const [flow, session] of byFlow) {
      for (const artifact of session.artifacts) {
        const kind = artifact?.kind;
        const file = artifact?.file;
        const declaredHash = artifact?.sha256;
        if (!EVIDENCE_ARTIFACT_KINDS.includes(kind)) {
          finding(
            findings,
            'manifest_parse_error',
            `Evidence manifest flow '${flow}' has artifact kind '${String(kind)}'`,
          );
          continue;
        }
        if (typeof file !== 'string' || !isSafeRelativePath(file)) {
          finding(
            findings,
            'manifest_parse_error',
            `Evidence manifest flow '${flow}' has an unsafe artifact file '${String(file)}'`,
          );
          continue;
        }
        if (typeof declaredHash !== 'string' || !SHA256_HEX.test(declaredHash)) {
          finding(
            findings,
            'manifest_parse_error',
            `Evidence manifest flow '${flow}' artifact '${file}' has no SHA-256`,
          );
          continue;
        }
        const filePath = path.join(manifestDir, file);
        let actualHash = null;
        try {
          actualHash = await sha256File(filePath);
        } catch {
          finding(findings, 'missing_file', `Evidence artifact is missing: ${file}`, file);
          continue;
        }
        if (actualHash !== declaredHash.toLowerCase()) {
          finding(
            findings,
            'file_digest_mismatch',
            `Evidence artifact digest mismatch for ${file}: manifest says ${declaredHash.slice(0, 12)}..., actual is ${actualHash.slice(0, 12)}...`,
            file,
          );
          continue;
        }
        declared.push({
          flow,
          sessionId: session.sessionId,
          kind,
          file,
          sha256: actualHash,
          filePath,
        });
      }
    }
  }

  // The original evidence defect was a host chat export mistakenly copied from
  // another flow. Identical artifact bytes bound to different sessions/flows
  // are exactly that defect class.
  const byHash = new Map();
  for (const artifact of declared) {
    const previous = byHash.get(artifact.sha256);
    if (
      previous &&
      (previous.flow !== artifact.flow || previous.sessionId !== artifact.sessionId)
    ) {
      finding(
        findings,
        'cross_session_artifact_duplicate',
        `Artifact '${artifact.file}' (${artifact.flow}) is byte-identical to '${previous.file}' (${previous.flow}); evidence for different sessions must not be a copy`,
        artifact.file,
      );
      continue;
    }
    if (!previous) byHash.set(artifact.sha256, artifact);
  }

  for (const artifact of declared) {
    if (artifact.kind !== 'flowguard-package') continue;
    const result = await verifyPackage(
      artifact.filePath,
      {
        expectSession: artifact.sessionId,
        expectFlow: artifact.flow,
        expectPhase: null,
        expectSharing: false,
      },
      core,
    );
    // Package-mode findings for a declared raw package are always errors here:
    // a manifest that points at a sharing archive is not a raw evidence set.
    for (const item of result.findings)
      findings.push({ ...item, file: `${artifact.file}: ${item.file ?? ''}` });
  }

  return { findings, sessions: declared };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function reportPackage(options, packagePath, result) {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          package: packagePath,
          classification: result.classification,
          verified: result.findings.length === 0 && result.classification === 'raw',
          sessionId: result.sessionId,
          flow: options.expectFlow,
          phase: result.phase,
          findings: result.findings,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`verify-evidence-package: ${packagePath}\n`);
  process.stdout.write(`  session: ${result.sessionId ?? '(unknown)'}\n`);
  process.stdout.write(`  flow:    ${options.expectFlow ?? '(not asserted)'}\n`);
  process.stdout.write(`  phase:   ${result.phase ?? '(unknown)'}\n`);
  process.stdout.write(`  classification: ${result.classification}\n`);
  for (const item of result.findings) {
    process.stdout.write(`  FINDING ${item.code}: ${item.message}\n`);
  }
  process.stdout.write(
    `  result: ${result.findings.length === 0 && result.classification === 'raw' ? 'VERIFIED' : result.classification === 'sharing' ? 'NOT FULLY VERIFIABLE (sharing archive)' : 'FAILED'}\n`,
  );
}

function reportManifest(options, manifestPath, result) {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          manifest: manifestPath,
          verified: result.findings.length === 0,
          sessions: result.sessions,
          findings: result.findings,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`verify-evidence-package: ${manifestPath} (evidence manifest)\n`);
  for (const session of result.sessions) {
    process.stdout.write(
      `  ${session.flow}: ${session.sessionId} (${session.kind}: ${session.file})\n`,
    );
  }
  for (const item of result.findings) {
    process.stdout.write(`  FINDING ${item.code}: ${item.message}\n`);
  }
  process.stdout.write(`  result: ${result.findings.length === 0 ? 'VERIFIED' : 'FAILED'}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const core = await loadCore();

  if (options.manifestPath !== null) {
    const result = await verifyEvidenceManifest(options.manifestPath, core);
    reportManifest(options, options.manifestPath, result);
    process.exit(result.findings.length === 0 ? EXIT.verified : EXIT.failed);
  }

  const packagePath = options.packagePath;
  try {
    await fs.access(packagePath);
  } catch {
    fail(`package not found: ${packagePath}`);
  }
  const result = await verifyPackage(
    packagePath,
    {
      expectSession: options.expectSession,
      expectFlow: options.expectFlow,
      expectPhase: options.expectPhase,
      expectSharing: options.expectSharing,
    },
    core,
  );
  reportPackage(options, packagePath, result);

  if (result.findings.length === 0 && result.classification === 'raw') process.exit(EXIT.verified);
  if (
    result.classification === 'sharing' &&
    options.expectSharing &&
    result.findings.length === 0
  ) {
    process.exit(EXIT.verified);
  }
  process.exit(result.classification === 'sharing' ? EXIT.sharing : EXIT.failed);
}

await main();
