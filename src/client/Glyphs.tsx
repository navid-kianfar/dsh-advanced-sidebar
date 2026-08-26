/**
 * The glyphs this plugin draws itself, because the client's icon set has no member for them.
 * Each is a 16×16 outline on `currentColor` at the icon family's stroke weight, so a menu mixing
 * these with set icons reads as one row of icons.
 * @module @achasoft/dsh-advanced-sidebar/client/Glyphs
 */

/** Props every glyph accepts; `size` overrides the 16px default for a denser row. */
export interface GlyphProps {
  /** Edge length in pixels. */
  size?: number
  /** Optional class, for a seat that colors or spaces its icons. */
  className?: string
}

/**
 * A page with a folded corner: one file.
 * @param props - size and class overrides.
 * @returns the glyph element.
 */
export function FileGlyph({ size = 16, className }: GlyphProps) {
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2Z" />
      <path d="M9 2v3.2a.8.8 0 0 0 .8.8H13" />
    </svg>
  )
}

/**
 * A window with a prompt caret: a terminal.
 * @param props - size and class overrides.
 * @returns the glyph element.
 */
export function TerminalGlyph({ size = 16, className }: GlyphProps) {
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M5 6.6 7 8.4 5 10.2" />
      <path d="M8.6 10.4H11" />
    </svg>
  )
}

/**
 * Two file cards with a plus and a minus: changed files.
 * @param props - size and class overrides.
 * @returns the glyph element.
 */
export function ChangesGlyph({ size = 16, className }: GlyphProps) {
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      <path d="M3.4 2.2h4L9.6 4.4v3.2" />
      <path d="M3.4 2.2v8.2" />
      <path d="M9.6 7.6H6.4A1.4 1.4 0 0 0 5 9v4.4a1.4 1.4 0 0 0 1.4 1.4h5.2a1.4 1.4 0 0 0 1.4-1.4V9a1.4 1.4 0 0 0-1.4-1.4Z" />
      <path d="M7.4 11.2h3.2" />
    </svg>
  )
}

/**
 * A browser window pushed out of a frame: open somewhere else.
 * @param props - size and class overrides.
 * @returns the glyph element.
 */
export function ExternalGlyph({ size = 16, className }: GlyphProps) {
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      <path d="M9.2 2.6H13.4V6.8" />
      <path d="M13.4 2.6 7.6 8.4" />
      <path d="M12 9.6v2.8a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4V5.4A1.4 1.4 0 0 1 3.6 4h2.8" />
    </svg>
  )
}
