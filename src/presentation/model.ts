/**
 * @module presentation/model
 * @description Canonical presentation data model for all FlowGuard user-facing output.
 *
 * Pure type layer. No imports from state/, machine/, config/, or rails/.
 * All authority decisions (blocker, readiness, next action) are projected
 * upstream by status-presentation.ts and similar builders.
 *
 * This is the SINGLE source of truth for presentation types. No duplicate
 * action representations, no ad-hoc section builders outside this module.
 *
 * @version v1
 */

// ─── Branded Normalized Markdown ───────────────────────────────────────────────

declare const normalizedMarkdownBrand: unique symbol;

/**
 * Markdown string that has passed structural validation.
 *
 * Guarantees:
 * - No leading newline
 * - No trailing newline
 * - No trailing whitespace on any line
 * - No triple-newlines between structural content (code-fence content may
 *   contain internal blank lines; the structural-spacing rule is enforced by
 *   the renderer, not the content validator)
 *
 * Only produced by {@link normalizedMarkdown}. Direct type assertions to this
 * type outside this module are a contract violation.
 */
export type NormalizedMarkdown = string & { readonly [normalizedMarkdownBrand]: true };

/**
 * Validate and brand a markdown string as structurally clean.
 * Rejects content that would violate the presentation spacing contract.
 * Empty strings are valid (no content).
 */
export function normalizedMarkdown(content: string): NormalizedMarkdown {
  if (content.length === 0) return '' as NormalizedMarkdown;
  if (content.startsWith('\n') || content.endsWith('\n')) {
    throw new PresentationContractError(
      'NormalizedMarkdown: content must not start or end with a newline.',
    );
  }
  if (/[ \t]+$/m.test(content)) {
    throw new PresentationContractError(
      'NormalizedMarkdown: content must not contain trailing whitespace on any line.',
    );
  }
  return content as NormalizedMarkdown;
}

/**
 * Validate a code-fence language identifier.
 * Rejects values that would corrupt the opening fence line.
 */
export function validateCodeLanguage(language: string | undefined): string {
  if (language === undefined) return '';
  if (!/^[A-Za-z0-9_+.#-]+$/.test(language)) {
    throw new PresentationContractError(
      `Invalid code-fence language: "${language}". ` + 'Language must match [A-Za-z0-9_+.#-]+.',
    );
  }
  return language;
}

// ─── Error ─────────────────────────────────────────────────────────────────────

export class PresentationContractError extends Error {
  public readonly code = 'PRESENTATION_CONTRACT_VIOLATION';

  constructor(message: string) {
    super(`Presentation contract violation: ${message}`);
    this.name = 'PresentationContractError';
  }
}

// ─── Action ────────────────────────────────────────────────────────────────────

/** Central action representation for commands and non-command actions. */
export interface PresentationAction {
  /** Slash-command invocation (e.g. "/approve") or null for non-command actions. */
  readonly invocation: string | null;
  /** Human-readable description of what the action does. */
  readonly description: string;
  /** Whether the action is recommended or merely available. */
  readonly visibility: 'recommended' | 'available';
}

// ─── Key-Value Item ────────────────────────────────────────────────────────────

/** A single label-value pair. Value must not be null — caller pre-filters. */
export interface KeyValueItem {
  readonly label: string;
  readonly value: string;
}

// ─── Artifact Item ─────────────────────────────────────────────────────────────

export interface ArtifactItem {
  readonly slot: string;
  readonly label: string;
  readonly status: 'complete' | 'missing' | 'not_yet_required' | 'failed';
  readonly required: boolean;
  readonly hint?: string;
}

// ─── Finding Groups ────────────────────────────────────────────────────────────

export interface FindingItem {
  readonly category: string;
  readonly message: string;
  readonly location?: string;
}

export interface FindingGroup {
  readonly severity: 'critical' | 'major' | 'warning' | 'info';
  readonly label: string;
  readonly items: readonly FindingItem[];
}

// ─── Checklist ─────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  readonly text: string;
  readonly checked: boolean;
}

// ─── Section Variants ──────────────────────────────────────────────────────────

/**
 * Top-level document title, rendered as a single H1 (`# text`).
 *
 * Distinct from a section `heading` (rendered as `## heading`). Use for the
 * card/document title only — there must be at most one TitleSection per
 * document, placed first. The renderer enforces non-empty text.
 */
export interface TitleSection {
  readonly kind: 'title';
  readonly text: string;
}

export interface KeyValueSection {
  readonly kind: 'keyValue';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  readonly items: readonly KeyValueItem[];
}

export interface CommandListSection {
  readonly kind: 'commandList';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  readonly items: readonly PresentationAction[];
}

export interface BlockerSection {
  readonly kind: 'blocker';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  /** Reason code — rendered in backticks. Null/omitted when not available. */
  readonly code: string | null;
  /** Human-readable reason text. */
  readonly text: string;
  /** Recovery instruction, when available from the canonical source. */
  readonly recovery?: string;
}

export interface ArtifactListSection {
  readonly kind: 'artifactList';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  readonly items: readonly ArtifactItem[];
}

export interface FindingsSection {
  readonly kind: 'findings';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  readonly groups: readonly FindingGroup[];
}

export interface ChecklistSection {
  readonly kind: 'checklist';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  /** Checklist label displayed inline above the items. */
  readonly label?: string;
  readonly items: readonly ChecklistItem[];
}

export interface TextSection {
  readonly kind: 'text';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  /** Validated markdown content — must pass {@link normalizedMarkdown}. */
  readonly content: NormalizedMarkdown;
}

export interface CodeSection {
  readonly kind: 'code';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  /** Validated language identifier — must pass {@link validateCodeLanguage}. */
  readonly language?: string;
  /** Code content — may contain internal blank lines. */
  readonly content: string;
}

/**
 * Generic advisory notice for non-authoritative warnings.
 *
 * Use for Discovery degradation, configuration normalisation warnings,
 * and similar runtime-advisory surfaces that must never be confused with
 * the authoritative Blocker section.
 */
export interface NoticeSection {
  readonly kind: 'notice';
  /** Visual severity level. */
  readonly level: 'warning' | 'not_verified' | 'info';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  /** Primary message body. */
  readonly message: string;
  /** Additional messages — each with its own symbol prefix. Optional, backwards-compatible. */
  readonly additionalMessages?: readonly string[];
  /** Structured detail rows. */
  readonly details: readonly KeyValueItem[];
}

/** Non-normative guidance status for action recommendations. */
export type GuidanceStatus = 'recommended' | 'not_recommended' | 'not_verified';

export interface GuidanceItem {
  readonly action: string;
  readonly status: GuidanceStatus;
  readonly reason: string;
}

export interface GuidanceSection {
  readonly kind: 'guidance';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  readonly items: readonly GuidanceItem[];
}

export interface BulletListSection {
  readonly kind: 'bulletList';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  readonly items: readonly string[];
}

// ─── Help / Diagnostic Primitives ─────────────────────────────────────────────

/** Visibility for detailed command lists — includes blocked_recoverable for help surfaces. */
export type DetailedCommandVisibility = 'recommended' | 'available' | 'blocked_recoverable';

export interface DetailedCommandItem {
  /** Never null — detail commands are always command-based. */
  readonly invocation: string;
  readonly description: string;
  readonly visibility: DetailedCommandVisibility;
  readonly aliases: readonly string[];
  readonly preflight:
    | { readonly status: 'available' }
    | {
        readonly status: 'blocked';
        readonly message: string | null;
        readonly reasonCode: string | null;
        readonly recovery: string | null;
      };
}

export interface DetailedCommandListSection {
  readonly kind: 'detailedCommandList';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  /** Plain-text label — renderer wraps in `**...:**`. */
  readonly label?: string;
  readonly items: readonly DetailedCommandItem[];
}

/** Combined phase / readiness / blocker / next-action summary for the /help surface. */
export interface HelpSummarySection {
  readonly kind: 'helpSummary';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  readonly phase: string | null;
  readonly readiness: string | null;
  readonly blocker: {
    readonly message: string | null;
    readonly reasonCode: string | null;
  } | null;
  readonly nextAction:
    | { readonly invocation: string; readonly description: string }
    | { readonly summary: string }
    | null;
}

/** Artifact meta-section for /help — ticket and plan status summaries. */
export interface HelpArtifactSection {
  readonly kind: 'helpArtifact';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  /** Plain-text label — renderer wraps in `**...:**`. */
  readonly label: string;
  readonly items: ReadonlyArray<{
    /** Plain-text label — renderer uses directly. */
    readonly label: string;
    readonly status: 'available' | 'not_verified';
    readonly preview: string | null;
    readonly digest: string | null;
  }>;
}

/**
 * Verbatim embedded Markdown content for /help artifact bodies.
 *
 * Internal content is preserved exactly. Only leading and trailing newline
 * characters at the section boundary are removed so the shared renderer
 * can enforce canonical spacing between sections. Trailing spaces and
 * internal blank lines remain opaque content.
 */
export interface EmbeddedMarkdownSection {
  readonly kind: 'embeddedMarkdown';
  /** Rendered as `## heading` when present. */
  readonly heading?: string;
  /** Plain-text label — renderer wraps in `**...:**`. */
  readonly label: string;
  readonly content: string;
}

export type PresentationSection =
  | TitleSection
  | KeyValueSection
  | CommandListSection
  | BlockerSection
  | ArtifactListSection
  | FindingsSection
  | ChecklistSection
  | TextSection
  | CodeSection
  | NoticeSection
  | BulletListSection
  | GuidanceSection
  | DetailedCommandListSection
  | HelpSummarySection
  | HelpArtifactSection
  | EmbeddedMarkdownSection;

// ─── Conclusion ────────────────────────────────────────────────────────────────

export type PresentationConclusion =
  | {
      readonly kind: 'next_action';
      readonly action: PresentationAction;
    }
  | {
      readonly kind: 'decision_required';
      /** The question the user must decide. */
      readonly question: string;
      /** Available actions — at most one may be recommended. */
      readonly actions: readonly PresentationAction[];
    }
  | {
      readonly kind: 'terminal';
      readonly message: string;
    };

// ─── Document Types ────────────────────────────────────────────────────────────

export interface CompactCardDocument {
  readonly kind: 'compact_card';
  readonly density: 'compact';
  readonly sections: readonly PresentationSection[];
  /** Compact cards always carry a conclusion. */
  readonly conclusion: PresentationConclusion;
}

export interface ReviewCardDocument {
  readonly kind: 'review_card';
  readonly sections: readonly PresentationSection[];
  /** Review cards may omit a conclusion when the card presents findings only. */
  readonly conclusion?: PresentationConclusion;
}

export interface DiagnosticCardDocument {
  readonly kind: 'diagnostic_card';
  readonly sections: readonly PresentationSection[];
  /** Diagnostic cards may omit a conclusion — blocked-action semantics are inline. */
  readonly conclusion?: PresentationConclusion;
}

export interface PlanDocument {
  readonly kind: 'plan_document';
  readonly sections: readonly PresentationSection[];
  /** Plan documents never carry a conclusion — the plan body is self-contained. */
  readonly conclusion?: never;
}

/** Surface-specific document for /help — no conclusion, flat section layout. */
export interface HelpDocument {
  readonly kind: 'help_document';
  readonly sections: readonly PresentationSection[];
  /** Help documents never carry a conclusion. */
  readonly conclusion?: never;
}

export type PresentationDocument =
  CompactCardDocument | ReviewCardDocument | DiagnosticCardDocument | PlanDocument | HelpDocument;
