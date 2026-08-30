/**
 * The kit's select: a trigger showing the current option and a floating list of the rest.
 *
 * A native `<select>` cannot be drawn in this vocabulary — its popup is the operating system's, and
 * on the platforms this Web Client runs on it ignores every colour the app resolves. The list here
 * is the same {@link Layer} the menu uses, so it flips and clamps like everything else.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Select
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconCheckOutline16, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Layer, insideLayerTree } from './Layer.tsx'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** One option. */
export interface SelectOption<T extends string> {
  /** The stored value. */
  value: T
  /** The rendered text. */
  label: ReactNode
  /** Shown beside the label, for the reason an option is unusable. */
  note?: string | undefined
  /** Refuses selection. */
  disabled?: boolean | undefined
}

/** Everything the select renders from. */
export interface SelectProps<T extends string> {
  /** The selected value; absent shows the placeholder. */
  value: T | undefined
  /**
   * A different option was chosen.
   * @param next - the chosen value.
   */
  onValueChange: (next: T) => void
  /** The options, in the order they are offered. */
  options: readonly SelectOption<T>[]
  /** Shown while nothing is selected. */
  placeholder?: string | undefined
  /** Refuses the press and dims the trigger. */
  disabled?: boolean | undefined
  /** Accessible name. */
  'aria-label'?: string | undefined
  /** The trigger's id, for a `<label for>`. */
  id?: string | undefined
  /** Additional classes on the trigger. */
  className?: string | undefined
}

/**
 * A select.
 * @param props - the value, the options, and the change callback.
 * @returns the trigger and, while open, its list.
 * @see {@link SelectProps}
 */
export function Select<T extends string>(props: SelectProps<T>) {
  const { value, onValueChange, options, placeholder, disabled = false, className, id } = props
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const treeId = useId()
  const selected = options.find(option => option.value === value)

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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx(css.trigger, className)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        {...id === undefined ? {} : { id }}
        {...props['aria-label'] === undefined ? {} : { 'aria-label': props['aria-label'] }}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={cx(css.triggerValue, selected === undefined && css.triggerPlaceholder)}>
          {selected?.label ?? placeholder}
        </span>
        <IconChevronDownOutline14 />
      </button>
      <Layer
        open={open}
        anchorRef={triggerRef}
        treeId={treeId}
        role="listbox"
        className={css.menu}
        placement={{ side: 'bottom', align: 'start', sideOffset: 4 }}
      >
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            className={css.item}
            disabled={option.disabled === true}
            onClick={() => {
              setOpen(false)
              triggerRef.current?.focus()
              if (option.value !== value) onValueChange(option.value)
            }}
          >
            <span className={css.itemBody}>
              <span className={css.itemLabel}>{option.label}</span>
              {option.note !== undefined && <span className={css.itemNote}>{option.note}</span>}
            </span>
            {option.value === value && <span className={css.itemCheck}><IconCheckOutline16 /></span>}
          </button>
        ))}
      </Layer>
    </>
  )
}
