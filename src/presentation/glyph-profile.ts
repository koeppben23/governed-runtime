/** Presentation-only glyph vocabulary for visible Markdown output. */
export type GlyphProfile = 'unicode' | 'ascii';

export interface PresentationRenderOptions {
  readonly glyphProfile?: GlyphProfile;
}

export interface PresentationGlyphs {
  readonly warning: string;
  readonly verified: string;
  readonly failed: string;
  readonly notVerified: string;
  readonly notApplicable: string;
  readonly recommendedAction: string;
  readonly availableAction: string;
}

export const UNICODE_GLYPHS: PresentationGlyphs = {
  warning: '⚠',
  verified: '✓',
  failed: '✗',
  notVerified: '?',
  notApplicable: '—',
  recommendedAction: '→',
  availableAction: '-',
};

const ASCII_GLYPHS: PresentationGlyphs = {
  warning: '[WARN]',
  verified: '[OK]',
  failed: '[FAIL]',
  notVerified: '[NOT_VERIFIED]',
  notApplicable: '[N/A]',
  recommendedAction: '[NEXT]',
  availableAction: '-',
};

export function presentationGlyphs(options: PresentationRenderOptions = {}): PresentationGlyphs {
  return options.glyphProfile === 'ascii' ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/**
 * Host-visible markdown variant for a review card: only transmitted when the
 * configured glyph profile actually changes the canonical card, so an identical
 * card is never sent twice.
 */
export function differencedCardPresentation(
  presentationMarkdown: string,
  canonicalCard: string,
): { readonly markdown: string } | undefined {
  return presentationMarkdown === canonicalCard ? undefined : { markdown: presentationMarkdown };
}
