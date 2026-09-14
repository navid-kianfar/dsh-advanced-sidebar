/**
 * Pieces the five panels share: the props they are all given, the two formatters that would
 * otherwise be written five times, and the path renderer.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/shared
 */

import { useEffect, useRef } from 'react'
import type { Translate } from '../contract.ts'
import type { OperationTarget } from '../controller.ts'
import type { PanelFace } from '../preview-types.ts'
import css from './Panels.module.css'

/** What every panel is handed by the dock. */
export interface PanelProps {
  /** The session and directory this panel acts on. */
  target: OperationTarget
  /** The namespace translator. */
  t: Translate
  /**
   * The dock's own injected face, minus the reserved `hooks` compartment: the renderer replaces
   * that with bound `use<Name>` selector props before the dock is rendered, so no panel ever sees
   * the sources themselves.
   */
  face: PanelFace
}

/** Binary size units, largest last so the loop can stop at the first that fits. */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Format a byte count for a file row.
 *
 * Locale-independent on purpose: these are units, not prose, and a translated "KB" would make a
 * size unreadable to anyone reading the same screen in the other language.
 * @param bytes - the size.
 * @returns the formatted size.
 */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1_024 && unit < UNITS.length - 1) {
    value /= 1_024
    unit += 1
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0)
  return `${rounded} ${UNITS[unit] ?? 'B'}`
}

/**
 * How many trailing characters of a path stay visible when it is too long for its box.
 *
 * Enough for a basename and a little of its directory, which is the part that identifies a row.
 */
const PATH_TAIL = 18

/**
 * Render one path, truncating in the MIDDLE rather than at either end.
 *
 * The usual one-line trick for this — `direction: rtl` with `text-overflow: ellipsis` — is wrong
 * for a path: the bidirectional algorithm reorders the neutral characters a path is made of, so
 * `dsh/tasks.db` renders as `dsh\tasks.db.` with the separator flipped and the ellipsis moved
 * inside the name. Two spans do it correctly and in one direction: the head clips with an ellipsis,
 * the tail never shrinks.
 * @param props.value - the path.
 * @param props.className - the row's own class; the container is a flex box.
 * @returns the path element.
 */
export function PathText({ value, className }: { value: string; className?: string | undefined }) {
  const cut = Math.max(0, value.length - PATH_TAIL)
  return (
    <span className={className} title={value}>
      <span className={css.pathHead}>{value.slice(0, cut)}</span>
      <span className={css.pathTail}>{value.slice(cut)}</span>
    </span>
  )
}

/**
 * Hold the latest value of something an effect reads but must not RESTART for.
 *
 * The translator is the case this exists for. Its identity changes on every locale switch, and an
 * effect that lists it as a dependency is torn down and re-run when the interface language
 * changes — which for the terminal effect means killing a running shell, and for a poll chain means
 * dropping and re-arming it. The effects need the current translator, not a reason to restart.
 * @param value - the value to track.
 * @returns a ref whose `current` is the latest value.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useEffect(() => { ref.current = value }, [value])
  return ref
}

/**
 * Phrase one transport failure for a panel's error line.
 * @param reason - whatever the call rejected with.
 * @param t - the namespace translator.
 * @returns a single-line message.
 */
export function transportMessage(reason: unknown, t: Translate): string {
  return t('error.transport', { message: reason instanceof Error ? reason.message : String(reason) })
}

/**
 * Join a typed path against the workspace unless it is already absolute.
 *
 * The Host proves containment either way — this is not a containment check — so the join only saves
 * a person from typing a long prefix. It is deliberately string arithmetic rather than a resolution:
 * the Host is the authority on what a path means, and a browser-side `..` walk would be a second,
 * weaker copy of that rule.
 * @param workspace - the absolute workspace directory.
 * @param path - the typed path.
 * @returns the absolute candidate the Host will resolve and contain.
 */
export function absoluteIn(workspace: string, path: string): string {
  return path.startsWith('/') ? path : `${workspace.replace(/\/$/u, '')}/${path}`
}
