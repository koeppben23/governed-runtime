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
    const [ticket, readme, demoScript, controllerTest] = await Promise.all([
      fs.readFile(TICKET_PATH, 'utf-8'),
      fs.readFile(README_PATH, 'utf-8'),
      fs.readFile(DEMO_SCRIPT_PATH, 'utf-8'),
      fs.readFile(CONTROLLER_TEST_PATH, 'utf-8'),
    ]);

    expect(ticket).toMatch(/remove.*@Disabled/is);
    expect(ticket).toMatch(/jsonPath\("\$\.taskId"\).*non-existent-id/is);
    expect(ticket).toMatch(/(?:replace.*Javadoc|Javadoc.*active regression)/is);
    expect(readme).toContain('assert `$.taskId`, and update its Javadoc');
    expect(demoScript).toContain('die `taskId`-Fehlerantwort prüfen');

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
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
