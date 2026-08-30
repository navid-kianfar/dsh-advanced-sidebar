/**
 * The kit's tab strip: shadcn's segmented control, with an optional per-tab close.
 *
 * The strip scrolls horizontally rather than wrapping. The panels it heads are full-height, so a
 * second row of tabs would take height from the thing being tabbed.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Tabs
 */

import type { ReactNode } from 'react'
import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** One tab. */
export interface TabDescriptor {
  /** Identifies the tab; reported to both callbacks. */
  id: string
  /** The tab's text. */
  label: ReactNode
  /** Native tooltip, for a label the strip clips. */
  title?: string | undefined
  /** Leading glyph, for a state marker. */
  icon?: ReactNode | undefined
}

/** Everything the strip renders from. */
export interface TabsProps {
  /** The tabs, in display order. */
  tabs: readonly TabDescriptor[]
  /** Which tab is showing. */
  value: string | undefined
  /**
   * A different tab was chosen.
   * @param id - the chosen tab.
   */
  onValueChange: (id: string) => void
  /**
   * A tab's close control was used; absent leaves the tabs uncloseable.
   * @param id - the tab to close.
   */
  onClose?: ((id: string) => void) | undefined
  /** Accessible name of the strip. */
  'aria-label'?: string | undefined
  /** Rendered after the tabs, inside the strip: the add button, a count, a toolbar. */
  children?: ReactNode | undefined
  /** Additional classes. */
  className?: string | undefined
}

/**
 * A tab strip.
 * @param props - the tabs, the selection, and the callbacks.
 * @returns the strip.
 * @see {@link TabsProps}
 */
export function Tabs(props: TabsProps) {
  const { tabs, value, onValueChange, onClose, children, className } = props
  return (
    <div
      className={cx(css.tabs, className)}
      role="tablist"
      {...props['aria-label'] === undefined ? {} : { 'aria-label': props['aria-label'] }}
    >
      <div className={css.tabsScroll}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === value}
            className={cx(css.tab, tab.id === value && css.tabActive)}
            {...tab.title === undefined ? {} : { title: tab.title }}
            onClick={() => { onValueChange(tab.id) }}
            onKeyDown={(event) => {
              // Delete closes the focused tab, which is the only keyboard path to the close
              // control: it is a span inside the tab button, because a button cannot nest one.
              if (onClose === undefined || event.key !== 'Delete') return
              event.preventDefault()
              onClose(tab.id)
            }}
            onAuxClick={(event) => {
              if (onClose === undefined || event.button !== 1) return
              event.preventDefault()
              onClose(tab.id)
            }}
          >
            {tab.icon}
            <span className={css.tabLabel}>{tab.label}</span>
            {onClose !== undefined && (
              <span
                className={css.tabClose}
                role="presentation"
                onPointerDown={(event) => {
                  // Down, not click: the tab's own click would otherwise select a tab that is
                  // about to disappear, moving the panel twice for one gesture.
                  event.preventDefault()
                  event.stopPropagation()
                  onClose(tab.id)
                }}
              >
                <IconCloseFill14 />
              </span>
            )}
          </button>
        ))}
      </div>
      {children}
    </div>
  )
}
