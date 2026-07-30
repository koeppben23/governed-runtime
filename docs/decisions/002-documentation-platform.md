# ADR-002: Documentation Platform

- **Status:** Proposed
- **Date:** 2026-07-30
- **Deciders:** FlowGuard maintainers

## Context

FlowGuard documentation currently uses:

- **TypeDoc** for API reference generation (HTML → GitHub Pages)
- **Plain Markdown** for architecture, guides, and product documentation (40+
  files in `docs/`)
- **GitHub-native Mermaid** for diagrams (introduced in the July 2026
  documentation alignment)

The documentation has suffered from **count-drift**: manual numeric claims
("12 tools", "23 files") diverged from the live code over time as tools and
mutation scopes grew. The July 2026 alignment introduced:

- `src/shared/product-inventory.ts` — canonical SSOT for all counts
- `docs/_inventory.generated.md` — build-time-generated inventory table
- Drift tests that CI-verify counts against code authorities

However, the documentation remains static Markdown. MDX (Markdown with embedded
JSX/React components) would allow documentation to be **self-verifying** — e.g.
a `<ToolInventory />` component that renders directly from the live code export
list, making stale counts structurally impossible.

## Options

### Option A: Stay on Plain Markdown + Generated Files

- **Current state.** Continue generating `_inventory.generated.md` at build
  time. Other docs reference the generated file.
- **Pros:** Zero new tooling. GitHub renders Markdown natively. All existing
  docs remain unchanged.
- **Cons:** Docs still contain manual text that can drift (phase descriptions,
  command tables, policy explanations). Only numeric counts are guarded.

### Option B: Docusaurus (React-based MDX)

- React-based documentation framework. MDX pages can import TypeScript modules
  at build time. Built-in Mermaid support. Versioned docs.
- **Pros:** Full MDX component model. Can import `PRODUCT_INVENTORY` directly.
  Mature ecosystem with many plugins.
- **Cons:** Requires React build tooling in a non-React project. Significant
  infrastructure investment. GitHub Pages deployment changes.

### Option C: Nextra (Next.js-based MDX)

- Next.js-based documentation framework. MDX pages with React components.
  File-system routing.
- **Pros:** Lightweight compared to Docusaurus. Next.js ecosystem. Good MDX
  support.
- **Cons:** Same infrastructure concerns as Docusaurus. Smaller plugin ecosystem.

### Option D: Starlight (Astro-based MDX)

- Astro-based documentation framework. MDX with zero-JS output by default.
- **Pros:** Minimal client-side JavaScript. Fast build times. Good Markdown/MDX
  support. Can import TypeScript at build time.
- **Cons:** Newer ecosystem. Smaller community than Docusaurus.

## Decision

**Defer.** The immediate drift problem is solved by the 2026-07 alignment
(product-inventory + generated files + drift tests). A full MDX platform
migration is not blocking.

**Evaluation criteria** for the future decision:

1. **Build-time code imports** — can documentation components import from
   `src/` at build time?
2. **Mermaid support** — does the platform render Mermaid natively?
3. **GitHub Pages deployment** — does the platform support `gh-pages` or
   GitHub Actions deployment?
4. **TypeDoc integration** — can the platform embed TypeDoc-generated API
   reference alongside hand-written MDX?
5. **Maintenance burden** — how many new devDependencies and config files?
6. **Migration effort** — how much manual work to convert existing Markdown?

## Consequences

- Product inventory guard tests (`product-inventory.test.ts`,
  `comment-count-drift.test.ts`) remain the primary drift prevention for now.
- `docs/_inventory.generated.md` is the bridge to any future MDX platform —
  it is a structured, machine-readable artifact that any MDX component can
  import.
- Mermaid diagrams introduced in the 2026-07 alignment work identically in
  plain Markdown and in any MDX platform.
