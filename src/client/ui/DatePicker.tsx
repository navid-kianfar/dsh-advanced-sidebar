/**
 * The kit's date picker: a trigger showing the chosen day, and the month grid in a floating layer.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/DatePicker
 */

import { useEffect, useId, useRef, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Calendar } from './Calendar.tsx'
import { Layer, insideLayerTree } from './Layer.tsx'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** Everything the picker renders from. */
export interface DatePickerProps {
  /** The chosen day; absent shows the placeholder. */
  value: Date | undefined
  /**
   * A different day was chosen, or the selection was cleared.
   * @param next - midnight at the start of the chosen local day, or undefined when cleared.
   */
  onValueChange: (next: Date | undefined) => void
  /** Shown while nothing is chosen. */
  placeholder: string
  /** The clear control's text inside the grid. */
  clearLabel: string
  /** The today control's text inside the grid. */
  todayLabel: string
  /** Accessible name of the previous-month control. */
  previousLabel: string
  /** Accessible name of the next-month control. */
  nextLabel: string
  /** Latest selectable day. */
  max?: Date | undefined
  /** BCP 47 tag for the month and weekday names. */
  locale?: string | undefined
  /** Accessible name of the trigger. */
  'aria-label'?: string | undefined
  /** Refuses the press and dims the trigger. */
  disabled?: boolean | undefined
  /** Additional classes on the trigger. */
  className?: string | undefined
}

/**
 * A date picker.
 * @param props - the selection, the labels, and the bounds.
 * @returns the trigger and, while open, the month grid.
 * @see {@link DatePickerProps}
 */
export function DatePicker(props: DatePickerProps) {
  const { value, onValueChange, placeholder, clearLabel, todayLabel } = props
  const { previousLabel, nextLabel, max, locale, disabled = false, className } = props
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const treeId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (insideLayerTree(event.target, treeId, triggerRef.current)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, treeId])

  const shown = value === undefined
    ? placeholder
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(value)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx(css.trigger, className)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...props['aria-label'] === undefined ? {} : { 'aria-label': props['aria-label'] }}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={cx(css.triggerValue, value === undefined && css.triggerPlaceholder)}>{shown}</span>
        <IconChevronDownOutline14 />
      </button>
      <Layer
        open={open}
        anchorRef={triggerRef}
        treeId={treeId}
        role="dialog"
        placement={{ side: 'bottom', align: 'start', sideOffset: 4 }}
      >
        <Calendar
          value={value}
          onValueChange={(next) => { setOpen(false); onValueChange(next) }}
          onClear={() => { setOpen(false); onValueChange(undefined) }}
          clearLabel={clearLabel}
          todayLabel={todayLabel}
          previousLabel={previousLabel}
          nextLabel={nextLabel}
          max={max}
          locale={locale}
        />
      </Layer>
    </>
  )
}
