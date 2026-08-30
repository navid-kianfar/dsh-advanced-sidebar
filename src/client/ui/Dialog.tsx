/**
 * The kit's modal: a scrimmed, centred card, and the confirmation form of it.
 *
 * Unlike the dock this plugin opens beside the conversation, a dialog IS modal: it takes focus,
 * traps it, and blocks the page behind its scrim. That is the whole difference between asking a
 * question and offering a panel, and it is why Delete uses this and the panels do not.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Dialog
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button.tsx'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** Everything a dialog renders from. */
export interface DialogProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Asked to close, from the scrim, Escape, or a cancel control. */
  onClose: () => void
  /** The heading. */
  title: string
  /** The body text; a caller with richer content passes `children` instead. */
  description?: ReactNode | undefined
  /** Body content below the description. */
  children?: ReactNode | undefined
  /** The action row. */
  footer?: ReactNode | undefined
  /** Refuses the scrim and Escape while an action is in flight. */
  busy?: boolean | undefined
  /** Additional classes on the card. */
  className?: string | undefined
}

/** Everything focus can land on inside a dialog. */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A modal dialog.
 * @param props - the open state, the heading, the body, and the action row.
 * @returns the portal, or null while closed.
 * @see {@link DialogProps}
 */
export function Dialog(props: DialogProps) {
  const { open, onClose, title, description, children, footer, busy = false, className } = props
  const cardRef = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const card = cardRef.current
    card?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    const restore = restoreRef.current
    return () => { restore?.focus() }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (busy) return
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const rows = [...(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (rows.length === 0) return
      const first = rows[0]
      const last = rows[rows.length - 1]
      // The cycle is closed here rather than left to the browser: the dialog is a portal at the end
      // of the body, so tabbing out of it lands in the page behind the scrim.
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open, busy, onClose])

  if (!open) return null
  return createPortal(
    <div
      className={css.dialogOverlay}
      role="presentation"
      onPointerDown={(event) => {
        if (busy || event.target !== event.currentTarget) return
        onClose()
      }}
    >
      <div ref={cardRef} className={cx(css.dialog, className)} role="dialog" aria-modal="true" aria-label={title}>
        <div>
          <h2 className={css.dialogTitle}>{title}</h2>
          {description !== undefined && <p className={css.dialogDescription}>{description}</p>}
        </div>
        {children}
        {footer !== undefined && <div className={css.dialogFooter}>{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/**
 * A confirmation dialog: a question, a cancel, and one action that commits it.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - dismiss without acting.
 * @param props.onConfirm - commit the action.
 * @param props.title - the question.
 * @param props.description - what committing will do.
 * @param props.confirmLabel - the committing control's text.
 * @param props.cancelLabel - the dismissing control's text.
 * @param props.destructive - draw the committing control as destructive.
 * @param props.busy - the action is in flight; both controls refuse.
 * @param props.children - extra body content between the description and the action row.
 * @returns the dialog.
 */
export function AlertDialog(props: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description?: ReactNode | undefined
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean | undefined
  busy?: boolean | undefined
  children?: ReactNode | undefined
}) {
  const { open, onClose, onConfirm, title, description, confirmLabel, cancelLabel } = props
  const { destructive = false, busy = false, children } = props
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      busy={busy}
      {...description === undefined ? {} : { description }}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{cancelLabel}</Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {children}
    </Dialog>
  )
}
