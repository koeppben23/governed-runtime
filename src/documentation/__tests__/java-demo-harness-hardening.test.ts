/** Exercises the demo's actual HTTP, state, audit and evidence boundaries. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runner } from '../../../demos/java-task-manager/run-live-matrix.mjs';
import { requestLoopback } from '../../../demos/lib/host-http.mjs';
import { withIsolatedService } from '../../../demos/lib/service-lifecycle.mjs';
import { computeStateDigest } from '../../integration/audit-outbox.js';

const SECRET = 'RAW_HTTP_SENTINEL_3fd8';
const SESSION = 'ses_parent';
const CODE = 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN';
const digestOf = (value: unknown) => computeStateDigest(value as never);
const state = {
  phase: 'EVIDENCE_REVIEW',
  flowguardSessionId: 'fg-session',
  binding: { hostSessionId: SESSION },
  pendingAuditOperations: [],
};

// Real subprocess and loopback HTTP. Only the remote peer's behavior is
// substituted; dispatch, file reservations, and validation are production code.
const SCRIPT = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const port = Number(process.argv.at(-1).split('=')[1]);
const secret = ${JSON.stringify(SECRET)};
const expected = 'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64');
const scenario = fs.readFileSync('scenario', 'utf8');
const digests = JSON.parse(fs.readFileSync('digests.json', 'utf8'));
const dir = path.join('workspaces','fixture','sessions','ses_parent');
const audit = path.join(dir,'audit.jsonl');
const stateFile = path.join(dir,'session-state.json');
function append(event, detail, overrides={}) {
  const auditSequence = fs.readFileSync(audit,'utf8').trim().split('\\n').length+1;
  fs.appendFileSync(audit, JSON.stringify({
    auditSequence, event, detail, occurredAt: new Date().toISOString(),
    flowguardSessionId: 'fg-session', hostSessionId: 'ses_parent', ...overrides,
  })+'\\n');
}
const server = http.createServer(async (req,res) => {
  if(req.headers.authorization !== expected && scenario !== 'unowned') {
    res.writeHead(401).end();
    return;
  }
  if(req.url === '/api/session') return res.writeHead(200).end();
  if(req.url === '/api/skip') {
    return res.end(process.env.FLOWGUARD_LIVE_SKIP_ASSERTION ?? 'unset');
  }
  if(req.url.endsWith('/wait')) {
    return scenario === 'wait-error' ? res.writeHead(503).end(secret) : res.writeHead(204).end();
  }
  fs.appendFileSync('dispatches', '1\\n');
  const parts = [];
  for await (const bytes of req) parts.push(bytes);
  const input = JSON.parse(Buffer.concat(parts));
  if(scenario === 'non204') return res.writeHead(500).end(secret);
  if(scenario === 'reset') {
    res.writeHead(500, {'content-length': 1000}).write(secret, () => res.destroy());
    return;
  }
  if(scenario === 'body-timeout') return res.writeHead(500).write(secret);
  if(scenario === 'redirect') return res.writeHead(307, {location: '/api/retry'}).end(secret);
  if(scenario === 'no-witness' || scenario === 'wait-error') return res.writeHead(204).end();
  const before = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const denial = !scenario.startsWith('positive');
  const expectedCode = ${JSON.stringify(CODE)};
  const call = {
    tool: 'flowguard_decision', success: !denial && scenario !== 'positive-failed-call', transitionCount: denial ? 0 : 1,
    argsSummary: {sessionID:'ses_parent',callID:scenario==='replay'?'old-call':'new-call'},
    ...(denial ? {errorCode: expectedCode} : {}),
  };
  if (scenario === 'wrong-call-binding') call.argsSummary.sessionID = 'ses_unrelated';
  if (scenario === 'wrong-denial-code') call.errorCode = 'UNRELATED';
  if (scenario === 'missing-call-id') delete call.argsSummary.callID;
  if (scenario === 'gap') append('note', {}, {auditSequence: 99});
  if (scenario === 'rewritten-prefix') {
    const original=JSON.parse(fs.readFileSync(audit,'utf8'));
    fs.writeFileSync(audit,JSON.stringify({...original,detail:{note:'replaced'}})+'\\n');
  }
  if (scenario === 'mutated-before-call') append('state_write', {}, {occurredAt:'2001-01-01T00:00:00.000Z'});
  append(scenario === 'wrong-tool' ? 'tool_call:flowguard_plan' : 'tool_call:flowguard_decision', call, {
    ...(scenario === 'foreign-session' ? {hostSessionId:'ses_foreign'} : {}),
    ...(scenario === 'stale-call' ? {occurredAt:'2001-01-01T00:00:00.000Z'} : {}),
  });
  if (scenario === 'two-calls') append('tool_call:flowguard_decision',call);
  if (denial) {
    if(scenario === 'mutated-state') fs.writeFileSync(stateFile,JSON.stringify({...before,other:'changed'}));
    if(scenario === 'receipt-during-refusal') append('decision:DEC-001',{});
    if(scenario === 'extra-call') append('tool_call:flowguard_status',{tool:'flowguard_status',success:false});
    if(scenario !== 'truncated') append('error:'+expectedCode,{code:scenario==='wrong-closing-code'?'UNRELATED':expectedCode});
    if(scenario === 'after-closing-error') append('note',{});
    return res.writeHead(500).end(secret);
  }
  const plan = before.phase === 'PLAN_REVIEW';
  const fromPhase = before.phase;
  const toPhase = digests.decisionPhase;
  const transitionEvent = 'DECISION_APPROVE';
  const transitionAt = new Date().toISOString();
  const preStateDigest = scenario === 'positive-synthetic-digests' ? 'a'.repeat(64) : digests.before;
  const postStateDigest = scenario === 'positive-synthetic-digests' ? 'b'.repeat(64) : digests.decisionPost;
  if (scenario !== 'positive-no-transition') {
    append('transition:'+transitionEvent, {
      from:fromPhase,to:toPhase,preStateDigest,
      postStateDigest:scenario==='positive-wrong-transition-digest'?'c'.repeat(64):postStateDigest,
    }, {occurredAt:transitionAt});
  }
  const rationale = scenario === 'positive-wrong-dispatch' ? 'a stale rationale' : input.text;
  const details = {
    verdict: 'approve', rationale, fromPhase, toPhase, transitionEvent, transitionAt,
    preStateDigest, postStateDigest, stateChanged:true, operation:{
      source:scenario === 'positive-wrong-source' ? 'autonomous' : 'host_command',
      sessionId:'ses_parent',rootSessionId:'ses_parent',
      operationId:scenario === 'positive-reused-operation' ? 'historical-operation' : 'op-1',
      stateDigest:preStateDigest,verdict:'approve',
      rationaleDigest:scenario==='positive-wrong-rationale-hash'?'c'.repeat(64):createHash('sha256').update(rationale).digest('hex'),
    },
  };
  append('decision:DEC-001',details);
  if(scenario==='positive-two-receipts') append('decision:DEC-002',details);
  if(digests.afterPhase !== toPhase) append('transition:VALIDATION_PASSED',{
    from:toPhase,to:digests.afterPhase,
    preStateDigest:scenario==='positive-digest-chain-gap'?'c'.repeat(64):postStateDigest,
    postStateDigest:digests.after,
  });
  if(scenario==='positive-digest-chain-gap') append('state_write',{
    preStateDigest:'c'.repeat(64),postStateDigest:digests.after,mutationDigest:digests.after,
  });
  if(scenario==='positive-ambiguous-tool') append('tool_call:flowguard_status',{tool:'flowguard_status'});
  if(scenario==='positive-failed-tool-no-code') append('tool_call:flowguard_status',{tool:'flowguard_status',success:false,transitionCount:0});
  if(scenario==='positive-success-with-error') append('tool_call:flowguard_status',{tool:'flowguard_status',success:true,errorCode:'UNEXPECTED',transitionCount:0});
  if(scenario==='positive-extra-error') append('error:UNEXPECTED',{code:'UNEXPECTED'});
  if(scenario!=='positive-unchanged') {
    const next = {...before, phase: digests.afterPhase};
    if(scenario==='positive-final-digest-mismatch') next.extra = 'mismatch';
    fs.writeFileSync(stateFile, JSON.stringify(next));
  }
  return res.writeHead(204).end();
});
server.listen(port,'127.0.0.1',()=>console.log('listening on http://127.0.0.1:'+port));
`;

describe('Java live harness', () => {
  let root: string;
  let helper: string;
  let configDir: string;
  let evidence: string;
  let stateFile: string;
  let port: number;
  let runner: Runner;

  function boundState(phase = state.phase) {
    return { ...state, phase, binding: { ...state.binding, worktree: root } };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-live-host-'));
    helper = path.join(root, 'host.cjs');
    configDir = path.join(root, 'config');
    evidence = path.join(root, 'evidence');
    const sessionDir = path.join(configDir, 'workspaces', 'fixture', 'sessions', SESSION);
    stateFile = path.join(sessionDir, 'session-state.json');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(evidence);
    await fs.writeFile(helper, SCRIPT);
    await fs.writeFile(stateFile, JSON.stringify(boundState()));
    await fs.writeFile(
      path.join(sessionDir, 'audit.jsonl'),
      JSON.stringify({
        auditSequence: 1,
        event: 'tool_call:flowguard_status',
        detail: {
          argsSummary: { callID: 'old-call' },
          operation: { operationId: 'historical-operation' },
        },
        occurredAt: '2001-01-01T00:00:00.000Z',
        flowguardSessionId: state.flowguardSessionId,
        hostSessionId: SESSION,
      }) + '\n',
    );
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runner = new Runner(root, { model: 'test/model', flows: [] }, configDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function args(skipAssertion = false) {
    return { configDir, port, command: process.execPath, argsPrefix: [helper], skipAssertion };
  }

  async function run<T>(scenario: string, callback: () => Promise<T>, skipAssertion = false) {
    const beforeState = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
    const phase = beforeState.phase;
    const decisionPhase =
      phase === 'PLAN_REVIEW'
        ? 'VALIDATION'
        : phase === 'ARCH_REVIEW'
          ? 'ARCH_COMPLETE'
          : 'EXPORT_READY';
    const afterPhase =
      phase === 'PLAN_REVIEW'
        ? 'IMPLEMENTATION'
        : phase === 'ARCH_REVIEW'
          ? 'ARCH_COMPLETE'
          : 'EXPORT_READY';
    await fs.writeFile(
      path.join(configDir, 'digests.json'),
      JSON.stringify({
        before: digestOf(beforeState),
        decisionPost: digestOf({ ...beforeState, phase: decisionPhase }),
        after: digestOf({ ...beforeState, phase: afterPhase }),
        decisionPhase,
        afterPhase,
      }),
    );
    runner.productStateDigest = async () => digestOf;
    await fs.writeFile(path.join(configDir, 'scenario'), scenario);
    return withIsolatedService(args(skipAssertion), async (host: typeof runner.host) => {
      runner.host = host;
      try {
        return await callback();
      } finally {
        runner.host = undefined;
      }
    });
  }

  const session = () => ({ workspace: root, sessionId: SESSION, terminal: 'COMPLETE' });
  function deny() {
    return runner.turn(session(), 'approval', undefined, {
      command: 'approve',
      expectedDenial: CODE,
      expectedDenialTool: 'flowguard_decision',
    });
  }

  it('accepts a native receipt and the subsequent automatic transition to implementation', async () => {
    await fs.writeFile(stateFile, JSON.stringify(boundState('PLAN_REVIEW')));
    await run('positive', () => runner.approve(session(), 'approval', 'PLAN_REVIEW'));
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8')).phase).toBe('IMPLEMENTATION');
  });

  it('accepts a bound unchanged refusal despite a failing HTTP response without retaining its body', async () => {
    const result = await run('refusal', deny);
    expect(result.auditEvidence).toEqual([
      expect.objectContaining({ tool: 'flowguard_decision', success: false, errorCode: CODE }),
    ]);
    expect(JSON.stringify({ result, observations: runner.turnObservations })).not.toContain(SECRET);
    expect(await fs.readFile(path.join(evidence, 'approval.jsonl'), 'utf8')).not.toContain(SECRET);
    expect(await fs.readFile(stateFile, 'utf8')).toBe(JSON.stringify(boundState()));
  });

  it.each([
    'no-witness',
    'positive-failed-call',
    'positive-wrong-dispatch',
    'positive-wrong-rationale-hash',
    'positive-wrong-source',
    'positive-reused-operation',
    'positive-two-receipts',
    'positive-unchanged',
    'positive-no-transition',
    'positive-wrong-transition-digest',
    'positive-synthetic-digests',
    'positive-digest-chain-gap',
    'positive-final-digest-mismatch',
    'positive-ambiguous-tool',
    'positive-failed-tool-no-code',
    'positive-success-with-error',
    'positive-extra-error',
  ])('does not credit a 204 approval with %s', async (scenario) => {
    await expect(
      run(scenario, () => runner.approve(session(), 'approval', 'EVIDENCE_REVIEW')),
    ).rejects.toMatchObject({ code: 'DEMO_NOT_VERIFIED' });
  });

  it.each([
    'wrong-tool',
    'gap',
    'rewritten-prefix',
    'foreign-session',
    'wrong-call-binding',
    'stale-call',
    'missing-call-id',
    'two-calls',
    'extra-call',
    'replay',
    'truncated',
    'mutated-before-call',
    'mutated-state',
    'receipt-during-refusal',
    'wrong-denial-code',
    'wrong-closing-code',
    'after-closing-error',
  ])('does not credit an ambiguous or mutating refusal: %s', async (scenario) => {
    await expect(run(scenario, deny)).rejects.toThrow();
    expect(await fs.readFile(path.join(configDir, 'dispatches'), 'utf8')).toBe('1\n');
    expect(runner.turnObservations).toEqual([]);
  });

  it('returns only status/byte length/digest for a response body', async () => {
    const result = await run('non204', () =>
      runner.hostCommand(session(), 'wire', 'approve', 'test rationale'),
    );
    expect(result).toMatchObject({
      status: 500,
      bodyLength: Buffer.byteLength(SECRET),
      bodySha256: createHash('sha256').update(SECRET).digest('hex'),
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(await fs.readFile(path.join(evidence, 'wire.jsonl'), 'utf8')).not.toContain(SECRET);
  });

  it.each(['reset', 'body-timeout', 'wait-error', 'redirect', 'non204'])(
    'marks %s unknown without leaking, following redirects, or retrying',
    async (scenario) => {
      runner.options.hostCommandTimeoutMs = 250;
      const rejects = run(scenario, () => runner.approve(session(), 'approval', 'EVIDENCE_REVIEW'));
      await expect(rejects).rejects.toMatchObject({ code: 'HOST_COMMAND_UNKNOWN_OUTCOME' });
      await expect(rejects).rejects.not.toThrow(SECRET);
      expect(await fs.readFile(path.join(configDir, 'dispatches'), 'utf8')).toBe('1\n');
      expect(await fs.readFile(path.join(evidence, 'approval.jsonl'), 'utf8')).not.toContain(
        SECRET,
      );
      expect(runner.turnObservations).toEqual([]);
    },
  );

  it('reserves native and CLI evidence exclusively before dispatch', async () => {
    await fs.writeFile(path.join(evidence, 'approval.jsonl'), 'original');
    await fs.writeFile(path.join(evidence, 'cli.err'), 'original');
    await run('positive', async () => {
      await expect(deny()).rejects.toMatchObject({ code: 'HOST_EVIDENCE_EXISTS' });
      await expect(runner.hostStep('cli', root, ['run'])).rejects.toMatchObject({
        code: 'HOST_EVIDENCE_EXISTS',
      });
    });
    await expect(fs.access(path.join(configDir, 'dispatches'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const file of ['approval.jsonl', 'cli.err']) {
      expect(await fs.readFile(path.join(evidence, file), 'utf8')).toBe('original');
    }
  });

  it('refuses a pre-existing listener without stopping it', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      await expect(
        run('positive', async () => {
          throw new Error('must not enter the callback');
        }),
      ).rejects.toMatchObject({ code: 'HOST_SERVICE_PORT_IN_USE' });
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects a service without the authentication proof and cleans up its process', async () => {
    await expect(
      run('unowned', async () => {
        throw new Error('must not enter the callback');
      }),
    ).rejects.toMatchObject({ code: 'HOST_SERVICE_OWNERSHIP_UNPROVEN' });
    await expect(requestLoopback(port, '/api/session', { method: 'GET' }, 200)).rejects.toThrow();
  });

  it.each([
    [false, 'unset'],
    [true, '1'],
  ] as const)(
    'binds the actual child environment to skip=%s and cleans up after failure',
    async (skip, actual) => {
      vi.stubEnv('FLOWGUARD_LIVE_SKIP_ASSERTION', skip ? undefined : '1');
      vi.stubEnv('OPENCODE_PASSWORD', 'foreign-password');
      await expect(
        run(
          'positive',
          async () => {
            const result = await runner.host.request('/api/skip', { method: 'GET' }, 500);
            expect(result.bodySha256).toBe(createHash('sha256').update(actual).digest('hex'));
            throw new Error('fixture failure');
          },
          skip,
        ),
      ).rejects.toThrow('fixture failure');
      await expect(requestLoopback(port, '/api/session', { method: 'GET' }, 200)).rejects.toThrow();
    },
  );
});
