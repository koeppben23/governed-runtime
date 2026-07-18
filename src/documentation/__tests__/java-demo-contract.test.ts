/**
 * @module documentation/java-demo-contract
 * @description Keeps the Java demo's initial fixture, ticket, and runbook aligned.
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
const TICKET_PATH = path.join(DEMO_DIR, 'seed', 'TICKET.md');
const README_PATH = path.join(DEMO_DIR, 'README.md');
const DEMO_SCRIPT_PATH = path.join(DEMO_DIR, 'DEMO_SCRIPT.md');
const CONTROLLER_TEST_PATH = path.join(
  DEMO_DIR,
  'seed',
  'src',
  'test',
  'java',
  'com',
  'example',
  'taskmanager',
  'controller',
  'TaskControllerTest.java',
);

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

  it('materializes the documented seed and review fixture branches', async () => {
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
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
