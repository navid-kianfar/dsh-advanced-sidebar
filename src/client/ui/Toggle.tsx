/**
 * The kit's two binary controls: a switch for a setting, a checkbox for a row selection.
 *
 * Both are `<button role="switch">` / `<button role="checkbox">` rather than a styled
 * `<input type="checkbox">`. A native checkbox cannot carry the thumb transition without pseudo
 * elements that no longer expose their state to assistive technology once the input is hidden.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Toggle
 */

import type { ReactNode } from 'react'
import { IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** What both binary controls take. */
export interface ToggleProps {
  /** Current state. */
  checked: boolean
  /**
   * The state changed.
   * @param next - the state after the press.
   */
  onCheckedChange: (next: boolean) => void
  /** Refuses the press and dims the control. */
  disabled?: boolean | undefined
  /** Accessible name, when no visible label is associated. */
  'aria-label'?: string | undefined
  /** The visible label's element id. */
  'aria-labelledby'?: string | undefined
  /** The control's own id, for a `<label for>`. */
  id?: string | undefined
  /** Additional classes. */
  className?: string | undefined
}

/**
 * A switch.
 * @param props - the state, the change callback, and the accessibility attributes.
 * @returns the switch element.
 * @see {@link ToggleProps}
 */
export function Switch(props: ToggleProps) {
  const { checked, onCheckedChange, disabled = false, className, ...aria } = props
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx(css.switch, className)}
      onClick={() => { onCheckedChange(!checked) }}
      {...aria}
    >
      <span className={css.switchThumb} />
    </button>
  )
}

/**
 * A checkbox.
 * @param props - the state, the change callback, and the accessibility attributes.
 * @returns the checkbox element.
 * @see {@link ToggleProps}
 */
export function Checkbox(props: ToggleProps) {
  const { checked, onCheckedChange, disabled = false, className, ...aria } = props
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className={cx(css.checkbox, className)}
      onClick={() => { onCheckedChange(!checked) }}
      {...aria}
    >
      {checked && <IconCheckOutline14 />}
    </button>
  )
}

/**
 * A checkbox with its label, as one click target.
 * @param props.checked - current state.
 * @param props.onCheckedChange - the state changed.
 * @param props.disabled - refuses the press.
 * @param props.children - the label.
 * @returns the labelled checkbox.
 */
export function CheckboxRow(props: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean | undefined
  children: ReactNode
}) {
  const { checked, onCheckedChange, disabled = false, children } = props
  return (
    <label className={css.checkRow}>
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      {children}
    </label>
  )
}
