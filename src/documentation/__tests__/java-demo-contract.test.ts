/**
 * @module documentation/java-demo-contract
 * @description Keeps the Java demo's initial fixture, ticket, runbook, and architecture task aligned.
 */

import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEMO_DIR = path.join(REPO_ROOT, 'demos', 'java-task-manager');
const SETUP_SCRIPT = path.join(DEMO_DIR, 'run-demo-setup.sh');
const SEED_DIR = path.join(DEMO_DIR, 'seed');
const TICKET_PATH = path.join(SEED_DIR, 'TICKET.md');
const ADR_TICKET_PATH = path.join(SEED_DIR, 'ADR_TICKET.md');
const README_PATH = path.join(DEMO_DIR, 'README.md');
const DEMO_SCRIPT_PATH = path.join(DEMO_DIR, 'DEMO_SCRIPT.md');
const REDUCED_CEREMONY_PATH = path.join(DEMO_DIR, 'REDUCED_CEREMONY.md');
const REDUCED_SETUP_SCRIPT = path.join(DEMO_DIR, 'run-reduced-ceremony-demo-setup.sh');
const TICKET_DOCS_PATH = path.join(SEED_DIR, 'TICKET_DOCS.md');
const PROOFGRAPH_VARIANTS_PATH = path.join(REPO_ROOT, 'demos', 'proofgraph-variants.md');
const CONTROLLER_TEST_PATH = path.join(
  SEED_DIR,
  'src',
  'test',
  'java',
  'com',
  'example',
  'taskmanager',
  'controller',
  'TaskControllerTest.java',
);
const SERVICE_PATH = path.join(
  SEED_DIR,
  'src',
  'main',
  'java',
  'com',
  'example',
  'taskmanager',
  'service',
  'TaskService.java',
);
const REPO_PATH = path.join(
  SEED_DIR,
  'src',
  'main',
  'java',
  'com',
  'example',
  'taskmanager',
  'repository',
  'TaskRepository.java',
);

function extractSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');

  const body = pattern.exec(markdown)?.[1];
  if (body === undefined) {
    throw new Error(`Missing section: ## ${heading}`);
  }

  return body.trim();
}

describe('Java Task Manager demo contract', () => {
  it('keeps the ticket and runbook explicit about the complete regression fix', async () => {
    const [ticket, readme, demoScript, controllerTest, demoPackage, proofGraphVariants] =
      await Promise.all([
        fs.readFile(TICKET_PATH, 'utf-8'),
        fs.readFile(README_PATH, 'utf-8'),
        fs.readFile(DEMO_SCRIPT_PATH, 'utf-8'),
        fs.readFile(CONTROLLER_TEST_PATH, 'utf-8'),
        fs.readFile(path.join(DEMO_DIR, 'seed', 'package.json'), 'utf-8'),
        fs.readFile(PROOFGRAPH_VARIANTS_PATH, 'utf-8'),
      ]);

    expect(ticket).toMatch(/remove.*@Disabled/is);
    expect(ticket).toMatch(/jsonPath\("\$\.taskId"\).*non-existent-id/is);
    expect(ticket).toMatch(/(?:replace.*Javadoc|Javadoc.*active regression)/is);
    expect(readme).toContain('assert `$.taskId`, and update its Javadoc');
    expect(demoScript).toContain('die `taskId`-Fehlerantwort prüfen');
    expect(demoScript).toContain('flowguard_status({ proofGraph: true })');
    expect(demoScript).toContain('contractClaimCount: 2');
    expect(demoScript).toContain('proofGraphGate.gated: false');
    expect(demoPackage).toContain('"build": "./mvnw verify"');
    expect(demoPackage).toContain('"test": "./mvnw test"');
    expect(proofGraphVariants).toContain('PROOFGRAPH_CRITICAL_FACTS_UNPROVEN');
    expect(proofGraphVariants).toContain('flowguard_record_mutation_evidence');
    expect(proofGraphVariants).toContain('./demos/run-proofgraph-variants.sh');
    expect(readme).toContain('integrityCapability: not_verifiable');
    expect(readme).toContain('verificationStatus: not_run');
    expect(demoScript).toContain('integrityCapability: not_verifiable');
    expect(demoScript).toContain('verificationStatus: not_run');
    expect(readme).toContain('/export redactionMode=none includeRaw=true');

    // The committed seed must remain the reproducible failing baseline, not the fix.
    expect(controllerTest).toContain('@Disabled("Regression: PUT /tasks/{id} returns HTTP 500');
    expect(controllerTest).toContain(
      'To reproduce manually: remove @Disabled and run ./mvnw test.',
    );
    expect(controllerTest).not.toContain('jsonPath("$.taskId").value("non-existent-id")');
  });

  it('keeps the architecture task structurally sound and distinct from a pre-written ADR', async () => {
    const [adrTicket, demoScript] = await Promise.all([
      fs.readFile(ADR_TICKET_PATH, 'utf-8'),
      fs.readFile(DEMO_SCRIPT_PATH, 'utf-8'),
    ]);

    // ADR_TICKET.md is a task, not a pre-written ADR — no MADR sections as own headings
    expect(adrTicket).not.toMatch(/^## Context\s*$/m);
    expect(adrTicket).not.toMatch(/^## Decision\s*$/m);
    expect(adrTicket).not.toMatch(/^## Consequences\s*$/m);

    // ADR_TICKET.md has task-specific sections
    expect(adrTicket).toContain('## Task Context');
    expect(adrTicket).toContain('## Requested Output');
    expect(adrTicket).toContain('## Constraints');
    expect(adrTicket).toContain('## Acceptance Criteria');

    // The Requested Output section requires MADR sections
    const requestedOutput = extractSection(adrTicket, 'Requested Output');
    expect(requestedOutput).toContain('`## Context`');
    expect(requestedOutput).toContain('`## Decision`');
    expect(requestedOutput).toContain('`## Consequences`');
    expect(requestedOutput).toMatch(/create a MADR-format.+ADR/i);

    // The ADR ticket itself references the concrete symbols
    expect(adrTicket).toContain('`TaskRepository.findById()`');
    expect(adrTicket).toContain('`TaskService.getTask()`');
    expect(adrTicket).toContain('`TaskService.updateTask()`');

    // Referenced symbols exist as methods in the seed code (not just words)
    const [serviceSrc, repoSrc] = await Promise.all([
      fs.readFile(SERVICE_PATH, 'utf-8'),
      fs.readFile(REPO_PATH, 'utf-8'),
    ]);
    expect(serviceSrc).toMatch(/\bgetTask\s*\(/);
    expect(serviceSrc).toMatch(/\bupdateTask\s*\(/);
    expect(repoSrc).toMatch(/\bfindById\s*\(/);

    // Demo script documents the Architecture part structurally
    expect(demoScript).toContain('Part 1');
    expect(demoScript).toContain('/architecture');
    expect(demoScript).toContain('ARCH_COMPLETE');
    expect(demoScript).toContain('ADR_TICKET.md');
  });

  it('keeps the reduced-ceremony A/B scenario bound to the runtime contract', async () => {
    const [reducedDoc, reducedSetup, ticketDocs, demoScript] = await Promise.all([
      fs.readFile(REDUCED_CEREMONY_PATH, 'utf-8'),
      fs.readFile(REDUCED_SETUP_SCRIPT, 'utf-8'),
      fs.readFile(TICKET_DOCS_PATH, 'utf-8'),
      fs.readFile(DEMO_SCRIPT_PATH, 'utf-8'),
    ]);

    // The docs-only task is deterministic and scoped to the single new file.
    expect(ticketDocs).toContain('docs/usage-notes.md');
    expect(ticketDocs).toContain('./mvnw verify');
    expect(ticketDocs).toContain('./mvnw test');
    expect(ticketDocs).toMatch(/Do not add files other than `docs\/usage-notes\.md`/);

    // The scenario documents both explicit policies, the waiver semantics and
    // the durable audit proof including the real archive member resolution.
    expect(reducedDoc).toContain('policy.allowReducedCeremony: true');
    expect(reducedDoc).toContain('policy.allowReducedCeremony: false');
    expect(reducedDoc).toContain('reduced_ceremony_applied');
    expect(reducedDoc).toContain('POST_IMPL_VERIFIED_TRIVIAL');
    expect(reducedDoc).toContain('tar -tzf');
    expect(reducedDoc).toContain('audit/audit.jsonl$');
    expect(reducedDoc).toContain('--verify-session');

    // The setup script writes both policies, checks parity and verifies the
    // runtime-selected active checks read-only.
    expect(reducedSetup).toContain('--verify-session');
    expect(reducedSetup).toContain('activeChecks');
    expect(reducedSetup).toContain("'HEAD^{tree}'");
    expect(reducedSetup).toContain('allowReducedCeremony');
    expect(reducedSetup).toContain('reduced-on');
    expect(reducedSetup).toContain('reduced-off');

    // The main script no longer claims reduced ceremony skips IMPL_VALIDATION.
    expect(demoScript).not.toMatch(/skipping\s+`?IMPL_VALIDATION/i);
    expect(demoScript).toContain('REDUCED_CEREMONY.md');
  });

  it('verifies the runtime active-check selection from a real session state', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-reduced-preflight-'));
    const workspace = path.join(tempDir, 'reduced-on');
    const configDir = path.join(tempDir, 'config');
    const stateDir = path.join(configDir, 'workspaces', 'fp-test', 'sessions', 'sid-test', 'state');
    const statePath = path.join(stateDir, 'session-state.json');
    const runVerify = () =>
      execFile('bash', [REDUCED_SETUP_SCRIPT, '--verify-session', workspace], {
        cwd: REPO_ROOT,
        env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
      });

    try {
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({ binding: { worktree: workspace }, activeChecks: ['test', 'build'] }),
        'utf-8',
      );
      const { stdout } = await runVerify();
      expect(stdout).toContain('activeChecks: [build, test]');
      expect(stdout).toContain('PASS  activeChecks selected as build + test');

      await fs.writeFile(
        statePath,
        JSON.stringify({ binding: { worktree: workspace }, activeChecks: ['build'] }),
        'utf-8',
      );
      await expect(runVerify()).rejects.toMatchObject({ code: 1 });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('materializes the documented seed including architecture task and review fixture branches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowguard-java-demo-contract-'));
    const targetDir = path.join(tempDir, 'workspace');

    try {
      await execFile('bash', [SETUP_SCRIPT, '--prepare-only', targetDir], { cwd: REPO_ROOT });

      const [
        { stdout: branch },
        { stdout: changedPaths },
        materializedTicket,
        materializedControllerTest,
      ] = await Promise.all([
        execFile('git', ['branch', '--show-current'], { cwd: targetDir }),
        execFile('git', ['diff', '--name-only', 'main...feature/add-due-date'], {
          cwd: targetDir,
        }),
        fs.readFile(path.join(targetDir, 'TICKET.md'), 'utf-8'),
        fs.readFile(
          path.join(
            targetDir,
            'src',
            'test',
            'java',
            'com',
            'example',
            'taskmanager',
            'controller',
            'TaskControllerTest.java',
          ),
          'utf-8',
        ),
      ]);

      expect(branch.trim()).toBe('main');
      expect(changedPaths).toContain('src/main/java/com/example/taskmanager/model/Task.java');
      expect(changedPaths).toContain(
        'src/main/java/com/example/taskmanager/dto/CreateTaskRequest.java',
      );
      expect(materializedTicket).toMatch(/remove.*@Disabled/is);
      expect(materializedTicket).toMatch(/jsonPath\("\$\.taskId"\).*non-existent-id/is);
      expect(materializedTicket).toMatch(/(?:replace.*Javadoc|Javadoc.*active regression)/is);
      expect(materializedControllerTest).toContain(
        '@Disabled("Regression: PUT /tasks/{id} returns HTTP 500',
      );

      // Architecture task is materialized into the workspace
      const materializedAdrTicket = await fs.readFile(
        path.join(targetDir, 'ADR_TICKET.md'),
        'utf-8',
      );
      expect(materializedAdrTicket).toContain('## Task Context');
      expect(materializedAdrTicket).toContain('## Requested Output');
      expect(materializedAdrTicket).toContain('`## Context`');
      expect(materializedAdrTicket).toContain('`## Decision`');
      expect(materializedAdrTicket).toContain('`## Consequences`');

      // The reduced-ceremony docs task is materialized with the seed.
      const materializedDocsTicket = await fs.readFile(
        path.join(targetDir, 'TICKET_DOCS.md'),
        'utf-8',
      );
      expect(materializedDocsTicket).toContain('docs/usage-notes.md');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
