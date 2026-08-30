/**
 * The kit's separator: a hairline between groups, in either orientation.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Separator
 */

import { cx } from '../cx.ts'
import css from './Ui.module.css'

/**
 * A hairline.
 * @param props.orientation - `horizontal` (default) draws a rule across the flow; `vertical` draws
 * one between two controls in a row.
 * @param props.className - additional classes.
 * @returns the separator element.
 */
export function Separator({ orientation = 'horizontal', className }: {
  orientation?: 'horizontal' | 'vertical' | undefined
  className?: string | undefined
}) {
  return (
    <hr
      className={cx(orientation === 'vertical' ? css.separatorVertical : css.separator, className)}
      aria-orientation={orientation}
    />
  )
}
