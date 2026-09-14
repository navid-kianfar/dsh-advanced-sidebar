/**
 * The contract every Preview mode's controls share with the panel that owns the frame.
 *
 * The panel owns one piece of state — what the frame is showing, in which mode, under which
 * viewport — and each mode's controls are handed a patch function rather than a setter per field.
 * One patch shape keeps the mode components from needing to know the whole state, and it is what
 * lets the agent's `open` control land on the same state a person's click writes.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/preview-mode
 */

import type { Translate } from '../contract.ts'
import type { PanelFace, PreviewMode } from '../preview-types.ts'

/** What the panel is showing, as every mode reads it. */
export interface PreviewModeState {
  /**
   * The URL of the framed document, as a frame can use it: an absolute URL for URL and Server
   * modes, the same-origin file route for a framed file, or the scratchpad route.
   *
   * Separate from the address a person typed because the two differ exactly where it matters: the
   * typed address is what an operator recognizes, the frame source is what makes the document
   * same-origin.
   */
  readonly src: string
  /** The address as a person or the agent spelled it, for the address bar. */
  readonly url: string
  /** The workspace this panel acts on, absent when the session has no directory. */
  readonly workspace: string | undefined
  /** The same-origin proxy route, absent when the Host serves none. */
  readonly proxyRoute: string | undefined
  /** Whether the framed document is same-origin with the GUI, so the agent can inspect it. */
  readonly inspectable: boolean
  /** The file being previewed, in file mode. */
  readonly filePath: string
  /** The frame viewport, pinned by the resize control or the agent; zero means "fit the dock". */
  readonly viewport: { readonly width: number; readonly height: number }
}

/** One patch to {@link PreviewModeState}; only the named fields change. */
export type PreviewModePatch = Partial<Omit<PreviewModeState, 'viewport'>> & {
  /** Replace the pinned viewport; zero for both means "fit the dock". */
  readonly viewport?: { readonly width: number; readonly height: number }
  /**
   * True when the patch is a person or agent COMMITTING a new document, which forces the frame to
   * remount even when the source string is unchanged (the reload Go provides).
   */
  readonly committed?: boolean
}

/** What every mode's controls are handed. */
export interface PreviewModeProps {
  /** The namespace translator. */
  t: Translate
  /** The panel's current state. */
  readonly state: PreviewModeState
  /** Apply a patch. */
  readonly setState: (patch: PreviewModePatch) => void
  /** Remount the frame, reloading whatever it shows. */
  readonly onReload: () => void
}

/** The panel's own state, mode included. */
export interface PreviewState extends PreviewModeState {
  /** Which mode is showing. */
  readonly mode: PreviewMode
}
