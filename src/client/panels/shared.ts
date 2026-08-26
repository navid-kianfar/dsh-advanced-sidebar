/**
 * Pieces the four panels share: the props they are all given, and the two formatters that would
 * otherwise be written four times.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/shared
 */

import type { PanelHostInjected, Translate } from '../contract.ts'
import type { OperationTarget } from '../controller.ts'

/** What every panel is handed by the drawer. */
export interface PanelProps {
  /** The session and directory this panel acts on. */
  target: OperationTarget
  /** The namespace translator. */
  t: Translate
  /**
   * The drawer's own injected face, minus the reserved `hooks` compartment: the renderer replaces
   * that with bound `use<Name>` selector props before the drawer is rendered, so no panel ever sees
   * the sources themselves.
   */
  face: Omit<PanelHostInjected, 'hooks'>
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
 * Phrase one transport failure for a panel's error line.
 * @param reason - whatever the call rejected with.
 * @param t - the namespace translator.
 * @returns a single-line message.
 */
export function transportMessage(reason: unknown, t: Translate): string {
  return t('error.transport', { message: reason instanceof Error ? reason.message : String(reason) })
}
