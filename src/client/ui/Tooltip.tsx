/**
 * The kit's tooltip: a hover/focus label placed with the same collision handling as every other
 * layer, so a control at the dock's right edge does not describe itself off screen.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Tooltip
 */

import { useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Layer } from './Layer.tsx'
import type { Side } from './anchor.ts'
import css from './Ui.module.css'

/** How long the pointer must rest before the label appears. */
const DELAY_MS = 400

/**
 * A tooltip around one child.
 *
 * The child is wrapped rather than cloned: cloning would need to merge a ref and four handlers into
 * whatever the caller passed, and a wrapper that lays out as its child costs nothing.
 * @param props.label - the text; an empty label renders the child alone.
 * @param props.side - preferred edge, flipped when the window cannot hold it there.
 * @param props.children - the element being described.
 * @returns the wrapped child, and the label while it is showing.
 */
export function Tooltip({ label, side = 'bottom', children }: {
  label: string
  side?: Side | undefined
  children: ReactElement | ReactNode
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const timer = useRef(0)

  const arm = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { setOpen(true) }, DELAY_MS)
  }
  const disarm = (): void => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }

  if (label === '') return <>{children}</>
  return (
    <>
      <span
        ref={anchorRef}
        style={{ display: 'contents' }}
        onPointerEnter={arm}
        onPointerLeave={disarm}
        onPointerDown={disarm}
        onFocusCapture={() => { setOpen(true) }}
        onBlurCapture={disarm}
      >
        {children}
      </span>
      <Layer
        open={open}
        anchorRef={anchorRef}
        role="tooltip"
        className={css.tooltip}
        placement={{ side, align: 'center', sideOffset: 6 }}
      >
        {label}
      </Layer>
    </>
  )
}
