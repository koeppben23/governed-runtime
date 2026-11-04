/** README artwork is a projection of current authorities, never a second workflow graph. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOW_PHASES, TRANSITIONS } from '../../machine/topology.js';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
const svg = readFileSync(
  new URL('../../../docs/assets/development-lifecycle.svg', import.meta.url),
  'utf8',
);
const nodes = [...svg.matchAll(/<g data-phase="([^"]+)">([\s\S]*?)<\/g>/g)];
const edges = [
  ...svg.matchAll(
    /<path class="(forward|revision)" data-from="([^"]+)" data-events="([^"]+)" data-to="([^"]+)" d="([^"]+)"\s*\/>/g,
  ),
].map((match) => ({
  kind: match[1],
  from: match[2],
  events: match[3]!.split(' '),
  to: match[4],
}));

describe('V2 README development lifecycle', () => {
  it('links the editable, accessible artwork and preserves its source attribution', () => {
    expect(readme).toContain('](./docs/assets/development-lifecycle.svg)');
    expect(svg).toContain('role="img" aria-labelledby="title description"');
    expect(svg).toContain('<title id="title">');
    expect(svg).toContain('<desc id="description">');
    expect(svg).toContain('Andreas Winter (wandi34), PR #1186');
    expect(svg).not.toMatch(/<script\b|<foreignObject\b|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });

  it('shows exactly the canonical ticket progression with matching visible phase labels', () => {
    expect(nodes.map((node) => node[1])).toEqual(FLOW_PHASES.ticket);
    for (const node of nodes) {
      expect(node[2]).toMatch(new RegExp(`>${node[1]}(?:<| · Export persisted<)`));
    }
    expect(
      edges.filter((edge) => edge.kind === 'forward').map(({ from, to }) => [from, to]),
    ).toEqual(
      FLOW_PHASES.ticket.slice(1).map((phase, index) => [FLOW_PHASES.ticket[index], phase]),
    );
  });

  it('maps every drawn transition and its complete event alternatives to the machine authority', () => {
    for (const edge of edges) {
      const phase = FLOW_PHASES.ticket.find((candidate) => candidate === edge.from);
      expect(phase).toBeDefined();
      if (!phase) throw new Error(`Unknown diagram phase: ${edge.from}`);
      const events = [...(TRANSITIONS.get(phase) ?? [])]
        .filter(([, target]) => target === edge.to)
        .map(([event]) => event);
      expect(edge.events, `${edge.from} → ${edge.to}`).toEqual(events);
    }
    const backedges = FLOW_PHASES.ticket.flatMap((phase, index) =>
      [...(TRANSITIONS.get(phase) ?? [])]
        .filter(([, target]) => {
          const targetIndex = FLOW_PHASES.ticket.findIndex((candidate) => candidate === target);
          return targetIndex >= 0 && targetIndex < index;
        })
        .map(([event, target]) => `${phase}:${event}:${target}`),
    );
    expect(
      edges
        .filter((edge) => edge.kind === 'revision')
        .flatMap((edge) => edge.events.map((event) => `${edge.from}:${event}:${edge.to}`))
        .sort(),
    ).toEqual(backedges.sort());
  });

  it('states activation, override, policy and omitted-path limits without claiming V2 acceptance', () => {
    const visible = svg
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    expect(visible).toContain('Activate with /start');
    expect(visible).toContain('/hydrate reloads workflow state; it does not activate governance.');
    expect(visible).not.toContain('/start or /hydrate');
    expect(visible).toContain('Approving an exhausted review requires /override-approve');
    expect(visible).toContain(
      'Policy may auto-approve ticket gates outside this human-gated example.',
    );
    expect(visible).toContain(
      'Eligible reduced ceremony may skip IMPL_REVIEW only after post-implementation verification',
    );
    expect(visible).toContain(
      'Technical validation blocks stay in their validation phase for retry.',
    );
    expect(visible).toContain('Review self-loops, rejection, abort and other flows are omitted.');
    expect(visible).toContain(
      'not acceptance evidence. R4 final reviewer-input integrity remains BLOCKED.',
    );
    expect(visible).toContain('Command origin is not verified human identity.');
    expect(readme).toContain('not completed V2\nacceptance.');
  });
});
