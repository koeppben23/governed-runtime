/** The installed Desktop entry is a CommonJS template; this test executes it
 * with host-shaped stubs before an installed Desktop run. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GUI_PLUGIN_BUNDLE } from './templates.js';

const pluginCleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of pluginCleanups.splice(0).reverse()) cleanup();
});

interface FakeCommand {
  readonly id: string;
  readonly run: () => void;
}

function load(
  ctx: Record<string, unknown>,
  session: Record<string, unknown>,
  available: { panel?: boolean; slot?: boolean; composerPill?: boolean } = {},
) {
  const panel = available.panel ?? true;
  const slot = available.slot ?? true;
  const composerPill = available.composerPill ?? true;
  const additions: Array<{ registry: string; value: unknown }> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const commandCalls: Array<Record<string, unknown>> = [];
  const views: unknown[] = [];
  const add = (registry: string, value: unknown) => additions.push({ registry, value });
  const host = {
    ...ctx,
    id: 'flowguard',
    add,
    layout: { open: vi.fn() },
    dialogs: {
      select: vi.fn(async () => '/task'),
      prompt: vi.fn(async () => 'Task description.'),
      confirm: vi.fn(async () => true),
    },
    sessions: { current: () => session },
    toast: { show: vi.fn() },
    ui: { Button: vi.fn(() => 'button') },
  };
  Object.assign(ctx, host);
  const module = { exports: {} as Record<string, unknown> };
  const requireStub = (name: string) => {
    if (name === '@opencode/plugin/gui') {
      return {
        Plugin: { define: (value: unknown) => value },
        Command: 'command',
        Panel: panel ? 'panel' : undefined,
        Slot: slot ? 'slot' : undefined,
        CodeBlock: 'code-block',
        ComposerPill: composerPill ? 'composer-pill' : undefined,
        createKeyed: (get: () => unknown, setup: (data: unknown) => void) => {
          const data = get();
          if (data) setup(data);
        },
      };
    }
    if (name === 'solid-js') {
      return {
        createEffect: (fn: () => void) => fn(),
        createSignal: (initial: unknown) => {
          let value = initial;
          return [() => value, (next: unknown) => (value = next)];
        },
        onCleanup: (cleanup: () => void) => pluginCleanups.push(cleanup),
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };
  const factory = new Function('require', 'module', 'exports', GUI_PLUGIN_BUNDLE);
  factory(requireStub, module, module.exports);
  const plugin = module.exports as {
    setup: (context: Record<string, unknown>) => void;
  };
  plugin.setup(host);
  const command = additions.find(
    (entry) =>
      entry.registry === 'command' && (entry.value as FakeCommand).id === 'choose-workflow',
  )?.value as FakeCommand;
  Object.assign(session, {
    id: 'ses_root',
    location: { directory: '/tmp/worktree' },
    server: {
      id: 'sidecar',
      client: {
        rpc: {
          call: vi.fn(async (input: Record<string, unknown>) => {
            rpcCalls.push(input);
            return { output: views.shift() ?? null };
          }),
        },
        session: {
          command: vi.fn(async (input: Record<string, unknown>) => {
            commandCalls.push(input);
          }),
        },
      },
    },
  });
  const probeCommand = additions.find(
    (entry) => entry.registry === 'command' && (entry.value as FakeCommand).id === 'ui-probe',
  )?.value as FakeCommand;
  const inlineCommand = additions.find(
    (entry) => entry.registry === 'command' && (entry.value as FakeCommand).id === 'show-chat-card',
  )?.value as FakeCommand | undefined;
  return { command, probeCommand, inlineCommand, additions, rpcCalls, commandCalls, views, host };
}

/** Minimal DOM test double: the installed host still owns actual visual acceptance. */
class FakeDomNode {
  readonly children: FakeDomNode[] = [];
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  readonly attributes = new Map<string, string>();
  disabled = false;
  open = false;
  type = '';
  private text = '';

  constructor(readonly tagName: string) {}

  set textContent(value: string) {
    this.text = value;
    this.children.length = 0;
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join(' ');
  }

  get childNodes(): FakeDomNode[] {
    return this.children;
  }

  get lastChild(): FakeDomNode | null {
    return this.children.at(-1) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: FakeDomNode): FakeDomNode {
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeDomNode): FakeDomNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }

  addEventListener(event: string, handler: () => void): void {
    this.listeners.set(event, handler);
  }

  removeEventListener(event: string): void {
    this.listeners.delete(event);
  }

  find(tag: string, label: string): FakeDomNode | undefined {
    if (this.tagName === tag && this.textContent.includes(label)) return this;
    for (const child of this.children) {
      const result = child.find(tag, label);
      if (result) return result;
    }
    return undefined;
  }
}

describe('installed Desktop GUI bundle', () => {
  it('registers all three on-demand Desktop companion commands', () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);

    expect(loaded.command.id).toBe('choose-workflow');
    expect(loaded.probeCommand.id).toBe('ui-probe');
    expect(loaded.inlineCommand?.id).toBe('show-chat-card');
  });

  it('does not register the inline composer command without ComposerPill', () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session, { composerPill: false });

    expect(loaded.command.id).toBe('choose-workflow');
    expect(loaded.probeCommand.id).toBe('ui-probe');
    expect(loaded.inlineCommand).toBeUndefined();
  });

  it('keeps the UI probe command registered but non-functional without Panel', () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session, { panel: false });
    loaded.probeCommand.run();

    expect(loaded.probeCommand.id).toBe('ui-probe');
    expect(loaded.additions.filter((item) => item.registry === 'panel')).toHaveLength(0);
    expect(loaded.host.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('does not support') }),
    );
    expect((loaded.host.layout as { open: ReturnType<typeof vi.fn> }).open).not.toHaveBeenCalled();
  });

  it('keeps the UI probe command registered but non-functional without Slot', () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session, { slot: false });
    loaded.probeCommand.run();

    expect(loaded.probeCommand.id).toBe('ui-probe');
    expect(loaded.host.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('does not support') }),
    );
    expect((loaded.host.layout as { open: ReturnType<typeof vi.fn> }).open).not.toHaveBeenCalled();
  });

  it('registers a dedicated read-only inline CodeBlock renderer', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const card = loaded.additions.find((item) => item.registry === 'code-block')?.value as {
      languages: string[];
      render: (input: {
        code: string;
        session?: Record<string, unknown>;
      }) => FakeDomNode | undefined;
    };
    expect(card.languages).toEqual(['flowguard-live']);
    expect(card.render({ code: 'unsupported', session })).toBeUndefined();
    expect(card.render({ code: 'v1' })).toBeUndefined();
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeDomNode(tag) });
    try {
      const rendered = card.render({ code: 'v1', session });
      expect(rendered?.attributes.get('role')).toBe('region');
      expect(rendered?.attributes.get('aria-label')).toBe('FlowGuard live status card');
      const announcements = rendered?.children.filter(
        (child) => child.attributes.get('aria-live') === 'polite',
      );
      expect(announcements).toHaveLength(2);
      expect(announcements?.every((child) => child.attributes.get('aria-atomic') === 'true')).toBe(
        true,
      );
      expect(rendered?.textContent).toContain('NOT_VERIFIED');
      expect(rendered?.textContent).toContain('not a historical decision');
      expect(loaded.commandCalls).toHaveLength(0);
      await vi.waitFor(() => expect(loaded.rpcCalls.length).toBeGreaterThan(0));
      expect(
        loaded.rpcCalls.every(
          (item) => item.method === 'GetNextAction' || item.method === 'GetWorkbenchReview',
        ),
      ).toBe(true);
      expect(loaded.commandCalls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('exposes read-only composer status without inserting a synthetic chat message', async () => {
    const loaded = load({}, {});
    const pill = loaded.additions.find((item) => item.registry === 'composer-pill')?.value as {
      show: (input: { session: Record<string, unknown> }) => {
        label: string;
        rows: Array<{ id: string; run?: () => void }>;
      };
    };
    expect(pill).toBeDefined();
    const initial = pill.show({ session: loaded.host.sessions.current() });
    expect(initial.label).toContain('FlowGuard');
    expect(initial.rows).toHaveLength(1);
    expect(loaded.rpcCalls).toHaveLength(0);
    expect(loaded.commandCalls).toHaveLength(0);
    initial.rows[0]?.run?.();
    await vi.waitFor(() => expect(loaded.rpcCalls.length).toBeGreaterThan(0));
    expect(loaded.rpcCalls[0]?.method).toBe('GetNextAction');
    expect(loaded.commandCalls).toHaveLength(0);
    const action = loaded.additions.find(
      (item) => item.registry === 'command' && (item.value as FakeCommand).id === 'show-chat-card',
    )?.value as FakeCommand;
    expect(action).toBeDefined();
    action.run();
    await vi.waitFor(() => expect(loaded.rpcCalls.length).toBeGreaterThan(1));
    expect(loaded.commandCalls).toHaveLength(0);
  });

  it('coalesces overlapping status reads into one in-flight and one catch-up read', async () => {
    const loaded = load({}, {});
    const pending: Array<(result: unknown) => void> = [];
    const session = loaded.host.sessions.current() as {
      id: string;
      server: { client: { rpc: { call: (input: unknown) => Promise<unknown> } } };
    };
    session.server.client.rpc.call = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    const pill = loaded.additions.find((item) => item.registry === 'composer-pill')?.value as {
      show: (input: { session: typeof session }) => {
        rows: Array<{ id: string; run?: () => void }>;
      };
    };
    const surface = pill.show({ session });
    const refresh = surface.rows.find((row) => row.id === 'refresh')?.run;
    refresh?.();
    refresh?.();
    refresh?.();
    expect(pending).toHaveLength(1);
    const response = {
      output: {
        kind: 'system_work',
        sessionID: session.id,
        stateDigest: 'a',
        phase: 'PLAN',
        title: 'Plan running',
        actions: [],
      },
    };
    pending[0]?.(response);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.(response);
    await vi.waitFor(() => expect(pill.show({ session }).rows).toHaveLength(2));
    expect(pending).toHaveLength(2);
    expect(loaded.commandCalls).toHaveLength(0);
  });

  it('ignores a late status response after plugin disposal', async () => {
    const loaded = load({}, {});
    const pending: Array<(result: unknown) => void> = [];
    const session = loaded.host.sessions.current() as {
      id: string;
      server: { client: { rpc: { call: (input: unknown) => Promise<unknown> } } };
    };
    session.server.client.rpc.call = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    const pill = loaded.additions.find((item) => item.registry === 'composer-pill')?.value as {
      show: (input: { session: typeof session }) => {
        rows: Array<{ id: string; label: string; run?: () => void }>;
      };
    };
    const surface = pill.show({ session });
    surface.rows.find((row) => row.id === 'refresh')?.run?.();
    expect(pending).toHaveLength(1);
    for (const cleanup of pluginCleanups.splice(0).reverse()) cleanup();
    pending[0]?.({
      output: {
        kind: 'system_work',
        sessionID: session.id,
        stateDigest: 'a',
        phase: 'PLAN',
        title: 'Late response must not apply',
        actions: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pill.show({ session }).rows.some((row) => row.label.includes('PLAN'))).toBe(false);
    expect(loaded.commandCalls).toHaveLength(0);
  });

  it('subscribes to the sidecar completion event and refreshes only the current session', async () => {
    const callbacks = new Map<string, (event: unknown) => void>();
    const unsubscribe = vi.fn();
    const on = vi.fn((type: string, callback: (event: unknown) => void) => {
      callbacks.set(type, callback);
      return unsubscribe;
    });
    const loaded = load(
      {
        servers: {
          get: (id: string) => (id === 'sidecar' ? { data: { on } } : undefined),
        },
      },
      {},
    );
    expect(on).toHaveBeenCalledWith('session.execution.succeeded', expect.any(Function));
    expect(loaded.rpcCalls).toHaveLength(0);
    callbacks.get('session.execution.succeeded')?.({ data: { sessionID: 'other' } });
    expect(loaded.rpcCalls).toHaveLength(0);
    const current = loaded.host.sessions.current();
    const server = current.server as Record<string, unknown>;
    server.id = 'remote';
    callbacks.get('session.execution.succeeded')?.({ data: { sessionID: 'ses_root' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loaded.rpcCalls).toHaveLength(0);
    server.id = 'sidecar';
    callbacks.get('session.execution.succeeded')?.({ data: { sessionID: 'ses_root' } });
    await vi.waitFor(() => expect(loaded.rpcCalls.length).toBeGreaterThan(0));
    expect(loaded.rpcCalls[0]?.method).toBe('GetNextAction');
    expect(loaded.commandCalls).toHaveLength(0);
  });

  it('also accepts the documented serverEndpoints lookup', () => {
    const on = vi.fn(() => vi.fn());
    load(
      {
        serverEndpoints: {
          get: (id: string) => (id === 'sidecar' ? { data: { on } } : undefined),
        },
      },
      {},
    );
    expect(on).toHaveBeenCalledWith('session.execution.succeeded', expect.any(Function));
  });

  it('registers a native panel but no slot until the experimental command is invoked', () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    expect(loaded.probeCommand.id).toBe('ui-probe');
    expect(loaded.additions.filter((item) => item.registry === 'panel')).toHaveLength(1);
    expect(loaded.additions.filter((item) => item.registry === 'slot')).toHaveLength(0);
    expect(loaded.command.id).toBe('choose-workflow');
  });

  it('opens its native panel and registers its header slot only on explicit opt-in', () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    loaded.probeCommand.run();
    loaded.probeCommand.run();

    expect(loaded.additions.filter((item) => item.registry === 'slot')).toHaveLength(1);
    expect((loaded.host.layout as { open: ReturnType<typeof vi.fn> }).open).toHaveBeenCalledWith(
      'flowguard:workbench-probe',
      session,
      { tab: 'select' },
    );
    expect(loaded.rpcCalls).toHaveLength(0);
    expect(loaded.commandCalls).toHaveLength(0);
  });

  it('renders independent review information without executing any decision', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeDomNode(tag) });
    try {
      const panel = loaded.additions.find((item) => item.registry === 'panel')?.value as {
        render: (props: { session: Record<string, unknown> }) => FakeDomNode;
      };
      const next = {
        sessionID: 'ses_root',
        kind: 'decision_required',
        phase: 'PLAN_REVIEW',
        stateDigest: 'a'.repeat(64),
        title: 'Plan decision required',
        decisionBinding: { subjectDigest: 'b'.repeat(64) },
        actions: [{ invocation: '/approve' }],
        blocker: null,
      };
      const review = {
        sessionID: 'ses_root',
        phase: 'PLAN_REVIEW',
        status: 'COMPLETE',
        subject: {
          kind: 'plan',
          label: 'Frozen plan revision 3',
          revision: '3',
          digest: 'b'.repeat(64),
          contentVerified: 'verified',
          subjectBinding: 'matched',
          reviewerVerdict: 'ACCEPT',
          reviewedSubjectDigest: 'b'.repeat(64),
          findings: [{ severity: 'high', category: 'rollback', message: 'Missing rollback proof' }],
          findingsTotal: 1,
          findingsTruncated: false,
          missingVerification: [],
          missingVerificationTruncated: false,
          unboundReviewReason: null,
          historicalReview: false,
        },
        proof: {
          claimsTotal: 1,
          claims: [
            {
              critical: true,
              statement: 'Rollback safe',
              verificationState: null,
              evidenceCount: 0,
            },
          ],
          claimsTruncated: false,
          coverageGapCount: 1,
        },
        warningCodes: [],
        warningsTruncated: false,
      };
      loaded.views.push(next, review);
      const node = panel.render({ session });
      expect(node.attributes.get('role')).toBe('region');
      expect(node.attributes.get('aria-label')).toBe('FlowGuard Review Workbench');
      await vi.waitFor(() => expect(node.textContent).toContain('Missing rollback proof'));
      expect(node.textContent).toContain('Reviewer verdict (not approval): ACCEPT');
      expect(node.textContent).toContain('Coverage gaps: 1');
      expect(node.textContent).toContain('NOT_VERIFIED');
      expect(node.find('button', 'Review operator decisions')?.disabled).toBe(false);
      expect(loaded.rpcCalls.map((call) => call['method'])).toEqual([
        'GetNextAction',
        'GetWorkbenchReview',
        'GetWorkbenchDiagnostics',
      ]);
      expect(loaded.commandCalls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps decision affordance disabled for stale or unverified review subjects', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeDomNode(tag) });
    try {
      const panel = loaded.additions.find((item) => item.registry === 'panel')?.value as {
        render: (props: { session: Record<string, unknown> }) => FakeDomNode;
      };
      loaded.views.push(
        {
          sessionID: 'ses_root',
          kind: 'decision_required',
          phase: 'PLAN_REVIEW',
          decisionBinding: { subjectDigest: 'b'.repeat(64) },
          actions: [{ invocation: '/approve' }],
          blocker: { code: null, message: 'Awaiting plan review decision', recovery: null },
        },
        {
          sessionID: 'ses_root',
          phase: 'PLAN_REVIEW',
          status: 'PARTIAL',
          subject: {
            kind: 'plan',
            label: 'Unbound plan',
            revision: '3',
            digest: 'c'.repeat(64),
            subjectBinding: 'mismatch',
            reviewerVerdict: 'ACCEPT',
            reviewedSubjectDigest: 'b'.repeat(64),
            findings: [],
            findingsTotal: 0,
            findingsTruncated: false,
            missingVerification: [],
            missingVerificationTruncated: false,
            unboundReviewReason: 'stale_revision',
            historicalReview: false,
          },
          proof: { claims: [], claimsTotal: 0, claimsTruncated: false, coverageGapCount: 0 },
          warningCodes: [],
          warningsTruncated: false,
        },
      );
      const node = panel.render({ session });
      await vi.waitFor(() => expect(node.textContent).toContain('Decision unavailable'));
      expect(node.find('button', 'Review operator decisions')?.disabled).toBe(true);
      expect(loaded.rpcCalls).toHaveLength(3);
      expect(loaded.commandCalls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the Workbench compact and expands review details only when needed', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeDomNode(tag) });
    try {
      const panel = loaded.additions.find((item) => item.registry === 'panel')?.value as {
        render: (props: { session: Record<string, unknown> }) => FakeDomNode;
      };
      loaded.views.push(
        {
          sessionID: 'ses_root',
          kind: 'decision_required',
          phase: 'PLAN_REVIEW',
          decisionBinding: { subjectDigest: 'b'.repeat(64) },
          actions: [{ invocation: '/approve' }],
          blocker: { code: null, message: 'Awaiting plan review decision', recovery: null },
        },
        {
          sessionID: 'ses_root',
          phase: 'PLAN_REVIEW',
          status: 'COMPLETE',
          subject: {
            kind: 'plan',
            label: 'Plan v1',
            revision: 'v1',
            digest: 'b'.repeat(64),
            subjectBinding: 'matched',
            reviewerVerdict: 'accept',
            reviewedSubjectDigest: 'b'.repeat(64),
            contentVerified: 'verified',
            findings: [],
            findingsTotal: 0,
            findingsTruncated: false,
            missingVerification: [],
            missingVerificationTruncated: false,
            unboundReviewReason: null,
            historicalReview: false,
          },
          proof: { claims: [], claimsTotal: 0, claimsTruncated: false, coverageGapCount: 0 },
          warningCodes: [],
          warningsTruncated: false,
        },
      );
      const node = panel.render({ session });
      await vi.waitFor(() => expect(node.textContent).toContain('Plan v1'));
      const cards = node.children.filter((child) => child.tagName === 'details');
      expect(cards).toHaveLength(8);
      expect(cards.map((card) => card.open)).toEqual([
        true,
        true,
        false,
        true,
        false,
        false,
        false,
        false,
      ]);
      const forensic = node.find('summary', 'Technical binding details');
      expect(forensic).toBeDefined();
      expect(node.find('button', 'Review operator decisions')?.disabled).toBe(false);
      const expand = node.find('button', 'Expand all details');
      expect(expand).toBeDefined();
      expand?.listeners.get('click')?.();
      expect(cards.every((card) => card.open)).toBe(true);
      expand?.listeners.get('click')?.();
      expect(cards.every((card) => !card.open)).toBe(true);
      expect(loaded.commandCalls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps READY minimal while linking only to the canonical workflow chooser', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeDomNode(tag) });
    try {
      const panel = loaded.additions.find((item) => item.registry === 'panel')?.value as {
        render: (props: { session: Record<string, unknown> }) => FakeDomNode;
      };
      loaded.views.push(
        {
          sessionID: 'ses_root',
          kind: 'choose_flow',
          phase: 'READY',
          stateDigest: 'a'.repeat(64),
          actions: [{ invocation: '/task' }],
        },
        {
          sessionID: 'ses_root',
          phase: 'READY',
          status: 'NOT_VERIFIED',
          subject: {
            label: 'No reviewable subject recorded',
            kind: 'none',
            revision: null,
            digest: null,
            subjectBinding: 'unavailable',
            reviewerVerdict: null,
            contentVerified: 'unavailable',
            findings: [],
            findingsTotal: 0,
            findingsTruncated: false,
            missingVerification: [],
            missingVerificationTruncated: false,
            unboundReviewReason: null,
            historicalReview: false,
          },
          proof: { claims: [], claimsTotal: 0, claimsTruncated: false, coverageGapCount: 0 },
          warningCodes: [],
          warningsTruncated: false,
        },
      );
      const node = panel.render({ session });
      await vi.waitFor(() => expect(node.textContent).toContain('No reviewable subject recorded'));
      const cards = node.children.filter((child) => child.tagName === 'details');
      expect(cards.map((card) => card.open)).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(node.find('button', 'Choose workflow')?.disabled).toBe(false);
      expect(loaded.commandCalls).toHaveLength(0);
      expect(loaded.rpcCalls.map((call) => call['method'])).toEqual([
        'GetNextAction',
        'GetWorkbenchReview',
        'GetWorkbenchDiagnostics',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders reviewer timeline and proof details', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeDomNode(tag) });
    try {
      const panel = loaded.additions.find((item) => item.registry === 'panel')?.value as {
        render: (props: { session: Record<string, unknown> }) => FakeDomNode;
      };
      loaded.views.push(
        {
          sessionID: 'ses_root',
          kind: 'system_work',
          phase: 'PLAN',
          stateDigest: 'a'.repeat(64),
          actions: [],
          blocker: null,
        },
        {
          sessionID: 'ses_root',
          phase: 'PLAN',
          status: 'PARTIAL',
          subject: {
            kind: 'plan',
            label: 'Plan v2',
            revision: 'v2',
            digest: 'b'.repeat(64),
            contentVerified: 'verified',
            subjectBinding: 'not_verified',
            reviewerVerdict: null,
            reviewedSubjectDigest: null,
            findings: [],
            findingsTotal: 0,
            findingsTruncated: false,
            missingVerification: [],
            missingVerificationTruncated: false,
            unboundReviewReason: null,
            historicalReview: false,
          },
          proof: {
            claimsTotal: 1,
            claims: [
              {
                statement: 'Retry is safe',
                critical: true,
                verificationState: 'NOT_VERIFIED',
                evidenceCount: 0,
                counterexampleCount: 2,
                certificateBinding: 'stale_or_unbound',
              },
            ],
            claimsTruncated: false,
            coverageGapCount: 1,
          },
          timeline: {
            source: 'review_assurance',
            status: 'truncated',
            total: 52,
            events: [
              {
                at: '2026-11-07T11:34:05.930Z',
                kind: 'dispatch',
                label: 'Reviewer dispatch authorized',
                state: 'outcome_unknown',
              },
            ],
          },
          warningCodes: ['REVIEWER_CAPTURE_PROVENANCE_INVALID'],
          warningsTruncated: false,
        },
      );
      const node = panel.render({ session });
      await vi.waitFor(() => expect(node.textContent).toContain('Reviewer dispatch authorized'));
      expect(node.textContent).toContain('Counterexample references: 2');
      expect(node.textContent).toContain('Certificate binding: stale_or_unbound');
      expect(node.textContent).toContain('outcome_unknown');
      expect(node.textContent).toContain('52 (partial - newest entries only)');
      expect(node.find('button', 'Review operator decisions')?.disabled).not.toBe(false);
      expect(loaded.commandCalls).toEqual([]);
      expect(loaded.rpcCalls.map((call) => call['method'])).toEqual([
        'GetNextAction',
        'GetWorkbenchReview',
        'GetWorkbenchDiagnostics',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders session lineage and verified audit without mutation', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    vi.stubGlobal('document', { createElement: (tag: string) => new FakeDomNode(tag) });
    try {
      const panel = loaded.additions.find((item) => item.registry === 'panel')?.value as {
        render: (props: { session: Record<string, unknown> }) => FakeDomNode;
      };
      loaded.views.push(
        {
          sessionID: 'ses_root',
          kind: 'system_work',
          phase: 'PLAN',
          stateDigest: 'a'.repeat(64),
          actions: [],
          blocker: null,
        },
        null,
        {
          sessionID: 'ses_root',
          explorer: {
            status: 'PARTIAL',
            lineage: 'partial',
            canonicalState: 'partial',
            sessions: [
              {
                sessionID: 'ses_root',
                parentSessionID: null,
                role: 'root',
                state: 'captured',
                lineage: 'verified',
                phase: 'PLAN',
                binding: 'verified',
                warningCodes: [],
              },
              {
                sessionID: 'ses_child',
                parentSessionID: 'ses_root',
                role: 'reviewer',
                state: 'unavailable',
                lineage: 'not_verified',
                phase: null,
                binding: 'unknown',
                warningCodes: ['SESSION_LINEAGE_NOT_VERIFIED'],
              },
            ],
            sessionsTruncated: false,
            reviewAttempts: [
              {
                ordinal: 1,
                childSessionID: 'ses_child',
                status: 'stale',
                dispatchStatus: 'outcome_unknown',
                obligationStatus: 'blocked',
              },
            ],
            reviewAttemptsTruncated: false,
            warningCodes: ['SESSION_LINEAGE_NOT_VERIFIED'],
          },
          audit: {
            source: 'verified_audit_chain_v3',
            status: 'PARTIAL',
            totalEvents: 1,
            eventsTruncated: false,
            sessions: [
              {
                sessionID: 'ses_root',
                integrity: 'verified',
                eventCount: 1,
                reasonCode: null,
              },
              {
                sessionID: 'ses_child',
                integrity: 'not_verified',
                eventCount: 0,
                reasonCode: 'SESSION_LINEAGE_OR_BINDING_NOT_VERIFIED',
              },
            ],
            events: [
              {
                sessionID: 'ses_root',
                sequence: 1,
                phase: 'PLAN',
                event: 'transition:PLAN',
                at: '2026-11-07T14:00:00.000Z',
                recordedAt: '2026-11-07T14:00:01.000Z',
              },
            ],
            note: 'Audit chronology is navigational; verified chains do not establish cross-session causality.',
          },
          decisionAuthority: 'not_granted',
        },
      );
      const node = panel.render({ session });
      await vi.waitFor(() => expect(node.textContent).toContain('SESSION_LINEAGE_NOT_VERIFIED'));
      expect(node.textContent).toContain('outcome_unknown');
      expect(node.textContent).toContain('transition:PLAN');
      expect(node.textContent).toContain('cross-session causality');
      expect(node.textContent).toContain('SESSION_LINEAGE_OR_BINDING_NOT_VERIFIED');
      const cards = node.children.filter((child) => child.tagName === 'details');
      expect(cards).toHaveLength(8);
      expect(cards.map((card) => card.open)).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(loaded.rpcCalls.map((call) => call['method'])).toEqual([
        'GetNextAction',
        'GetWorkbenchReview',
        'GetWorkbenchDiagnostics',
      ]);
      expect(loaded.commandCalls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('runs the selected workflow command after re-reading the same view', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const view = {
      kind: 'choose_flow',
      stateDigest: 'a'.repeat(64),
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      decisionBinding: null,
      title: 'Choose a workflow',
      actions: [{ invocation: '/task', description: 'Start.', visibility: 'available' }],
    };
    loaded.views.push(view, view);

    loaded.command.run();

    await vi.waitFor(() =>
      expect(loaded.commandCalls).toContainEqual({
        sessionID: 'ses_root',
        name: 'task',
        text: 'Task description.',
      }),
    );
    expect(loaded.rpcCalls.map((call) => call['method'])).toEqual([
      'GetNextAction',
      'GetNextAction',
    ]);
  });

  it('requests the on-demand next action only after confirmation and a fresh view', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const view = {
      kind: 'next_action',
      stateDigest: 'a'.repeat(64),
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      decisionBinding: null,
      title: 'Plan required',
      actions: [
        { invocation: '/plan', description: 'Create the plan.', visibility: 'recommended' },
      ],
    };
    loaded.views.push(view, view, view);
    (ctx.dialogs as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValueOnce('/plan');

    loaded.command.run();

    await vi.waitFor(() =>
      expect(loaded.commandCalls).toContainEqual({
        sessionID: 'ses_root',
        name: 'plan',
        text: '',
      }),
    );
    expect((ctx.dialogs as { confirm: ReturnType<typeof vi.fn> }).confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirm: '/plan' }),
    );
  });

  it('submits a decision only when the displayed subject binding is unchanged', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const binding = {
      sessionID: 'ses_root',
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      stateDigest: 'a'.repeat(64),
      phase: 'PLAN_REVIEW',
      obligationId: '22222222-2222-4222-8222-222222222222',
      subjectDigest: 'c'.repeat(64),
      reviewType: 'plan',
      reviewCycle: 1,
      iteration: 1,
    };
    const view = {
      kind: 'decision_required',
      stateDigest: 'a'.repeat(64),
      activationId: binding.activationId,
      activationGeneration: 1,
      policyDigest: binding.policyDigest,
      decisionBinding: binding,
      title: 'Plan decision required',
      actions: [{ invocation: '/approve', description: 'Approve.', visibility: 'available' }],
    };
    loaded.views.push(view, {
      ...view,
      decisionBinding: { ...binding, subjectDigest: 'd'.repeat(64) },
    });
    (ctx.dialogs as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValueOnce('/approve');

    loaded.command.run();

    await vi.waitFor(() => expect(loaded.rpcCalls).toHaveLength(2));
    expect(loaded.rpcCalls.some((call) => call['method'] === 'SubmitDecision')).toBe(false);
    expect(loaded.commandCalls).toEqual([]);
    expect((ctx.toast as { show: ReturnType<typeof vi.fn> }).show).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'error' }),
    );
  });

  it('does not execute a next action when the session switches during confirmation', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const view = {
      kind: 'next_action',
      stateDigest: 'a'.repeat(64),
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      decisionBinding: null,
      title: 'Plan required',
      actions: [{ invocation: '/plan', description: 'Create plan.', visibility: 'recommended' }],
    };
    loaded.views.push(view, view);
    (ctx.dialogs as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValueOnce('/plan');
    (ctx.dialogs as { confirm: ReturnType<typeof vi.fn> }).confirm.mockImplementationOnce(
      async () => {
        (ctx.sessions as { current: () => unknown }).current = () => ({
          id: 'ses_other',
          server: { id: 'other_server' },
        });
        return true;
      },
    );

    loaded.command.run();

    await vi.waitFor(() =>
      expect((ctx.toast as { show: ReturnType<typeof vi.fn> }).show).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'error' }),
      ),
    );
    expect(loaded.commandCalls).toEqual([]);
    expect(loaded.rpcCalls.filter((call) => call['method'] === 'SubmitDecision')).toEqual([]);
  });

  it('does not submit an override when the session switches during rationale input', async () => {
    const ctx = {} as Record<string, unknown>;
    const session = {} as Record<string, unknown>;
    const loaded = load(ctx, session);
    const binding = {
      sessionID: 'ses_root',
      activationId: '11111111-1111-4111-8111-111111111111',
      activationGeneration: 1,
      policyDigest: 'b'.repeat(64),
      stateDigest: 'a'.repeat(64),
      phase: 'PLAN_REVIEW',
      obligationId: '22222222-2222-4222-8222-222222222222',
      subjectDigest: 'c'.repeat(64),
      reviewType: 'plan',
      reviewCycle: 1,
      iteration: 1,
    };
    const view = {
      kind: 'decision_required',
      stateDigest: binding.stateDigest,
      activationId: binding.activationId,
      activationGeneration: binding.activationGeneration,
      policyDigest: binding.policyDigest,
      decisionBinding: binding,
      title: 'Decision required',
      actions: [
        {
          invocation: '/override-approve',
          description: 'Override an exhausted gate.',
          visibility: 'available',
        },
      ],
    };
    loaded.views.push(view, view);
    (ctx.dialogs as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValueOnce(
      '/override-approve',
    );
    (ctx.dialogs as { prompt: ReturnType<typeof vi.fn> }).prompt.mockImplementationOnce(
      async () => {
        (ctx.sessions as { current: () => unknown }).current = () => ({
          id: 'ses_other',
          server: { id: 'other_server' },
        });
        return 'Documented reason.';
      },
    );

    loaded.command.run();

    await vi.waitFor(() =>
      expect((ctx.toast as { show: ReturnType<typeof vi.fn> }).show).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'error' }),
      ),
    );
    expect(loaded.rpcCalls.filter((call) => call['method'] === 'SubmitDecision')).toEqual([]);
    expect(loaded.commandCalls).toEqual([]);
  });
});
