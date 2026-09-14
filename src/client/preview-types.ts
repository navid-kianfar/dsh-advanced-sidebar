/**
 * The Preview panel's own faces: what its modes are handed, and the narrow slice of the dock's
 * injected face the command driver needs.
 *
 * Split out from the panel component so the driver — which is not a React component and must be
 * testable and readable on its own — does not import the component that imports it.
 * @module @achasoft/dsh-advanced-sidebar/client/preview-types
 */

import type { PanelHostInjected } from './contract.ts'

/** The dock's injected face without the reserved `hooks` compartment, as every panel receives it. */
export type PanelFace = Omit<PanelHostInjected, 'hooks'>

/**
 * The endpoints the command driver calls, and only those.
 *
 * Narrowed deliberately: a driver handed the whole panel face could reach a git write, and the
 * point of the split is that the agent channel's browser end can do exactly three things — ask for
 * work, report a result, and say it left.
 */
export type PreviewFace = Pick<PanelFace, 'previewPoll' | 'previewResult' | 'previewRelease'>

/** Which mode the Preview panel is showing. */
export type PreviewMode = 'server' | 'file' | 'url' | 'scratchpad'
