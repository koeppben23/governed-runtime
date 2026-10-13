#!/usr/bin/env node
/**
 * Offline ISO/IEC 27001:2022 evidence-to-control demo.
 *
 * Runs entirely against a built checkout (`npm run build`) and needs no host,
 * no model, and no network:
 *
 * 1. creates a temporary, standalone foreign git repository (fixed test
 *    remote, so the workspace fingerprint is deterministic),
 * 2. seeds a synthetic secure-development session from
 *    `seed/session-state.template.json` + `seed/audit.jsonl` (product fixture
 *    shapes; the variable binding is patched with the canonical primitives),
 * 3. materializes the artifacts and publishes the real raw completion export
 *    with `archiveCompletionExport`,
 * 4. verifies the package with the canonical `verifyCompletionExport`,
 * 5. runs the built CLI three times:
 *    - positive mapping (A.8.29 + A.8.32 + export live binding) -> exit 0,
 *      EVIDENCE_LINKED_VERIFIED, companion report equals stdout,
 *    - negative mapping (skipped assertion + aggregate report) -> exit 0,
 *      EVIDENCE_MISSING / NOT_VERIFIED, never verified,
 *    - tampered package copy -> exit 2, no report; the original is restored
 *      afterwards and re-verified unchanged.
 *
 * Every expectation is checked; any deviation exits non-zero.
 *
 * Usage: node demos/iso27001-evidence-mapping/run-demo.mjs [--root <dir>] [--keep]
 *
 * Exit codes: 0 all scenarios passed; 1 an expectation failed; 2 setup error.
 *
 * @version v1
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');
const CLI_ENTRY = path.join(DIST, 'cli', 'install.js');
const SEED_DIR = path.join(SCRIPT_DIR, 'seed');

const DEMO_REMOTE = 'https://github.com/flowguard-test/iso27001-demo.git';
const DEMO_SESSION_ID = 'ses_iso27001_demo_session_0001';

const failures = [];
const summary = [];

function check(condition, message) {
  if (condition) {
    summary.push(`PASS ${message}`);
  } else {
    failures.push(message);
    summary.push(`FAIL ${message}`);
  }
}

function fail(message) {
  console.error(`[demo:error] ${message}`);
  process.exit(2);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseArgs(argv) {
  let root = null;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') {
      root = argv[i + 1] ?? null;
      if (root === null) fail('--root requires a value');
      i++;
    } else if (arg === '--keep') {
      keep = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { root, keep };
}

async function loadProduct() {
  const load = (relative) => import(pathToFileURL(path.join(DIST, relative)).href);
  if (!(await fs.stat(CLI_ENTRY).catch(() => null))) {
    fail('dist/cli/install.js not found; run `npm run build` first');
  }
  const [
    hashing,
    canonicalJson,
    certificate,
    fingerprint,
    workspace,
    artifacts,
    persistence,
    audit,
    archive,
    verify,
  ] = await Promise.all([
    load('shared/hashing.js'),
    load('shared/canonical-json.js'),
    load('state/proofgraph-plan-certificate.js'),
    load('adapters/workspace/fingerprint.js'),
    load('adapters/workspace/init.js'),
    load('adapters/workspace/evidence-artifacts.js'),
    load('adapters/persistence.js'),
    load('adapters/persistence-audit.js'),
    load('adapters/workspace/archive.js'),
    load('adapters/workspace/archive-verify-chain.js'),
  ]);
  return {
    hashText: hashing.hashText,
    hashFile: hashing.hashFile,
    canonicalJsonStringify: canonicalJson.canonicalJsonStringify,
    planApprovalCertificateIdentity: certificate.planApprovalCertificateIdentity,
    computeFingerprint: fingerprint.computeFingerprint,
    initWorkspace: workspace.initWorkspace,
    sessionDir: workspace.sessionDir,
    materializeEvidenceArtifacts: artifacts.materializeEvidenceArtifacts,
    writeState: persistence.writeState,
    appendAuditEvent: audit.appendAuditEvent,
    archiveCompletionExport: archive.archiveCompletionExport,
    verifyCompletionExport: verify.verifyCompletionExport,
  };
}

/**
 * Patch the variable binding fields of the seed template and re-mint the plan
 * approval certificate with the canonical primitives (`hashText`,
 * `canonicalJsonStringify`, `planApprovalCertificateIdentity`). No hashes are
 * invented here: the attestation digest and certificate id are recomputed by
 * the same authority the product uses at mint time.
 */
function patchState(product, template, worktree, fingerprint) {
  const state = JSON.parse(JSON.stringify(template));
  const binding = { ...state.binding, worktree, fingerprint };
  state.binding = binding;
  const bindingDigest = product.hashText(product.canonicalJsonStringify(binding));
  const plan = state.plan;
  if (plan?.approvalCertificate) {
    const certificate = plan.approvalCertificate;
    const approvalAttestation = { ...certificate.approvalAttestation, bindingDigest };
    const decisionAttestationDigest = product.hashText(
      product.canonicalJsonStringify(approvalAttestation),
    );
    const certificateId = product.planApprovalCertificateIdentity({
      authorityDigest: certificate.authorityDigest,
      claimDeclarationsDigest: certificate.claimDeclarationsDigest,
      decisionAttestationDigest,
      planVersion: certificate.planVersion,
      planRecordDigest: certificate.planRecordDigest,
      reviewBinding: certificate.reviewBinding,
      approvedAt: certificate.approvedAt,
    });
    plan.approvalCertificate = {
      ...certificate,
      approvalAttestation,
      decisionAttestationDigest,
      certificateId,
    };
  }
  return state;
}

function runCli({ worktree, configDir, args }) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: worktree,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir, FORCE_COLOR: '0' },
    timeout: 30_000,
  });
}

function rulesOf(report) {
  const rules = [];
  for (const control of report.controls) {
    for (const rule of control.rules) rules.push(rule);
  }
  return rules;
}

function ruleById(report, ruleId) {
  return rulesOf(report).find((rule) => rule.ruleId === ruleId);
}

function controlByPath(report, namespace, controlId) {
  return report.controls.find(
    (control) =>
      control.controlRef.namespace === namespace && control.controlRef.controlId === controlId,
  );
}

function findingCodes(rule) {
  return [
    ...rule.findings.map((finding) => finding.code),
    ...rule.selectors.flatMap((selector) => selector.findings.map((finding) => finding.code)),
  ];
}

async function setupSession(product, root) {
  const worktree = path.join(root, 'foreign-repo');
  const configDir = path.join(root, 'opencode-config');
  await fs.mkdir(worktree, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  // The demo process seeds the session into its own run root; the CLI child
  // receives the same directory through the inherited environment.
  process.env.OPENCODE_CONFIG_DIR = configDir;

  const git = (args) =>
    spawnSync('git', args, { cwd: worktree, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
  if (git(['init', '--quiet']).status !== 0) fail('git init failed');
  if (git(['remote', 'add', 'origin', DEMO_REMOTE]).status !== 0) fail('git remote add failed');

  const template = JSON.parse(
    await fs.readFile(path.join(SEED_DIR, 'session-state.template.json'), 'utf8'),
  );
  const initialized = await product.initWorkspace(worktree, DEMO_SESSION_ID);
  check(
    template.binding.fingerprint === initialized.fingerprint,
    `workspace fingerprint matches the baked seed (${initialized.fingerprint})`,
  );

  const state = patchState(product, template, worktree, initialized.fingerprint);
  await product.materializeEvidenceArtifacts(
    initialized.sessionDir,
    state,
    product.hashText(product.canonicalJsonStringify(state)),
  );
  // Written directly: the seed intentionally snapshots the documented
  // pre-completion EXPORT_READY boundary; the product's write-time approval
  // guard is not bypassed at runtime because the export rail - not this demo -
  // owns the approved transition into EXPORT_READY.
  await fs.writeFile(
    path.join(initialized.sessionDir, 'session-state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
  await fs.copyFile(
    path.join(SEED_DIR, 'audit.jsonl'),
    path.join(initialized.sessionDir, 'audit.jsonl'),
  );

  const exportPath = await product.archiveCompletionExport(
    initialized.fingerprint,
    DEMO_SESSION_ID,
  );
  const packageDigest = await product.hashFile(exportPath);
  const verification = await product.verifyCompletionExport(
    initialized.fingerprint,
    DEMO_SESSION_ID,
  );
  check(verification.passed === true, 'canonical verifier accepts the published export');

  // Live completion after the documented temporal boundary: the archived
  // snapshot stays EXPORT_READY while the live session records the completion.
  const liveState = {
    ...state,
    phase: 'COMPLETE',
    exportCompletionEvidence: {
      id: randomUUID(),
      packageDigest,
      purpose: 'auditor',
      integrityCapability: 'verifiable',
      createdAt: '2026-01-01T00:01:00.000Z',
    },
  };
  await product.writeState(initialized.sessionDir, liveState);
  await product.appendAuditEvent(initialized.sessionDir, {
    id: randomUUID(),
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: DEMO_SESSION_ID,
    phase: 'COMPLETE',
    event: 'transition:EXPORT_MATERIALIZED',
    occurredAt: '2026-01-01T00:01:00.000Z',
    actor: 'machine',
    detail: {
      kind: 'transition',
      from: 'EXPORT_READY',
      to: 'COMPLETE',
      event: 'EXPORT_MATERIALIZED',
      autoAdvanced: false,
      chainIndex: -1,
    },
  });

  return {
    worktree,
    configDir,
    fingerprint: initialized.fingerprint,
    sessionDir: initialized.sessionDir,
    exportPath,
    packageDigest,
  };
}

async function positiveScenario(product, fixture, root) {
  const mappingPath = path.join(SEED_DIR, 'mapping.positive.json');
  const outputPath = path.join(root, 'report.companion.json');
  const stateBefore = await fs.readFile(
    path.join(fixture.sessionDir, 'session-state.json'),
    'utf8',
  );
  const packageBefore = await product.hashFile(fixture.exportPath);

  const result = runCli({
    worktree: fixture.worktree,
    configDir: fixture.configDir,
    args: [
      'inspect',
      '--session',
      DEMO_SESSION_ID,
      '--iso27001-mapping',
      mappingPath,
      '--json',
      '--output',
      outputPath,
    ],
  });
  check(result.status === 0, `positive run exits 0 (got ${result.status})`);
  if (result.status !== 0) {
    failures.push(`positive stderr: ${result.stderr.slice(0, 500)}`);
    return;
  }

  const report = JSON.parse(result.stdout);
  check(
    report.reportSchemaVersion === 'iso27001-evidence-report.v1',
    'report schema is iso27001-evidence-report.v1',
  );
  check(
    report.evidencePackage.packageSha256 === fixture.packageDigest,
    'report package digest equals the verified package digest',
  );

  const a829 = ruleById(report, 'sec-testing');
  check(
    a829?.status === 'EVIDENCE_LINKED_VERIFIED',
    'A.8.29 sec-testing is EVIDENCE_LINKED_VERIFIED',
  );
  const assertionSelector = a829?.selectors?.find(
    (selector) => selector.selector.kind === 'validation.assertion_passed',
  );
  check(
    assertionSelector?.evidence?.[0]?.attemptId === '00000000-0000-4000-8000-000000000766',
    'A.8.29 assertion evidence binds the seeded attempt id',
  );

  const changeControl = ruleById(report, 'change-control');
  check(
    changeControl?.status === 'EVIDENCE_LINKED_VERIFIED',
    'A.8.32 change-control is EVIDENCE_LINKED_VERIFIED',
  );
  check(
    changeControl?.selectors?.every(
      (selector) => selector.status === 'EVIDENCE_LINKED_VERIFIED',
    ) === true,
    'A.8.32 plan, revision and human decision are all verified',
  );

  const exportRule = ruleById(report, 'export-evidence');
  check(
    exportRule?.status === 'EVIDENCE_LINKED_VERIFIED',
    'export.completion live binding is EVIDENCE_LINKED_VERIFIED',
  );

  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ['iso_compliant', 'control_satisfied', 'certified', 'audit_passed']) {
    check(!serialized.includes(forbidden), `report contains no '${forbidden}' conclusion`);
  }

  const companion = await fs.readFile(outputPath, 'utf8');
  check(companion === result.stdout, 'companion report equals the printed report');
  check(
    (await fs.readFile(path.join(fixture.sessionDir, 'session-state.json'), 'utf8')) ===
      stateBefore,
    'positive run leaves the session state unchanged',
  );
  check(
    (await product.hashFile(fixture.exportPath)) === packageBefore,
    'positive run leaves the package unchanged',
  );
}

async function negativeScenario(product, fixture) {
  const mappingPath = path.join(SEED_DIR, 'mapping.negative.json');
  const result = runCli({
    worktree: fixture.worktree,
    configDir: fixture.configDir,
    args: ['inspect', '--session', DEMO_SESSION_ID, '--iso27001-mapping', mappingPath, '--json'],
  });
  check(result.status === 0, `negative run exits 0 with a valid report (got ${result.status})`);
  if (result.status !== 0) {
    failures.push(`negative stderr: ${result.stderr.slice(0, 500)}`);
    return;
  }
  const report = JSON.parse(result.stdout);

  const skipped = ruleById(report, 'skipped-assertion');
  check(skipped?.status === 'EVIDENCE_MISSING', 'skipped assertion is EVIDENCE_MISSING');
  check(
    findingCodes(skipped).includes('ASSERTION_SKIPPED'),
    'skipped assertion reports ASSERTION_SKIPPED',
  );

  const aggregate = ruleById(report, 'aggregate-not-attested');
  check(aggregate?.status === 'NOT_VERIFIED', 'aggregate report binding is NOT_VERIFIED');
  check(
    findingCodes(aggregate).includes('ASSERTION_BINDING_NOT_ATTESTED'),
    'aggregate report reports ASSERTION_BINDING_NOT_ATTESTED',
  );

  const control = controlByPath(report, 'iso27001:2022/annexA', 'A.8.29');
  check(
    control?.status === 'NOT_VERIFIED',
    'the affected control aggregates to NOT_VERIFIED, never a pass',
  );
}

async function tamperScenario(product, fixture, root) {
  const original = await fs.readFile(fixture.exportPath);
  const originalDigest = sha256(original);
  const backupPath = path.join(root, 'export-original.tar.gz');
  await fs.writeFile(backupPath, original);

  await fs.writeFile(fixture.exportPath, Buffer.concat([original, Buffer.from('tamper')]));
  const result = runCli({
    worktree: fixture.worktree,
    configDir: fixture.configDir,
    args: [
      'inspect',
      '--session',
      DEMO_SESSION_ID,
      '--iso27001-mapping',
      path.join(SEED_DIR, 'mapping.positive.json'),
      '--json',
    ],
  });
  check(result.status === 2, `tampered package exits 2 (got ${result.status})`);
  check(result.stdout === '', 'tampered package produces no report');
  check(
    result.stderr.includes('PACKAGE_UNVERIFIABLE'),
    'tampered package reports PACKAGE_UNVERIFIABLE',
  );

  await fs.copyFile(backupPath, fixture.exportPath);
  check(
    sha256(await fs.readFile(fixture.exportPath)) === originalDigest,
    'original package restored byte-for-byte',
  );
  const verification = await product.verifyCompletionExport(fixture.fingerprint, DEMO_SESSION_ID);
  check(verification.passed === true, 'restored original verifies again');
}

async function main() {
  const { root: requestedRoot, keep } = parseArgs(process.argv.slice(2));
  const root =
    requestedRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-iso27001-demo-')));
  if (requestedRoot !== null) {
    if (await fs.stat(requestedRoot).catch(() => null)) {
      fail(`run root already exists: ${requestedRoot}`);
    }
    await fs.mkdir(requestedRoot, { recursive: true });
  }

  console.log(`[demo] run root: ${root}`);
  const product = await loadProduct();
  const fixture = await setupSession(product, root);
  const originals = {
    state: await fs.readFile(path.join(fixture.sessionDir, 'session-state.json'), 'utf8'),
    package: await product.hashFile(fixture.exportPath),
  };

  await positiveScenario(product, fixture, root);
  await negativeScenario(product, fixture);
  await tamperScenario(product, fixture, root);

  check(
    (await fs.readFile(path.join(fixture.sessionDir, 'session-state.json'), 'utf8')) ===
      originals.state,
    'all scenarios leave the session state unchanged',
  );
  check(
    (await product.hashFile(fixture.exportPath)) === originals.package,
    'all scenarios leave the original package unchanged (only the tamper copy was altered and restored)',
  );

  for (const line of summary) console.log(`[demo] ${line}`);
  if (!keep) await fs.rm(root, { recursive: true, force: true });
  else console.log(`[demo] kept run root: ${root}`);

  if (failures.length > 0) {
    console.error(`[demo] ${failures.length} expectation(s) failed:`);
    for (const failure of failures) console.error(`[demo]   ${failure}`);
    process.exit(1);
  }
  console.log('[demo] all scenarios passed');
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
