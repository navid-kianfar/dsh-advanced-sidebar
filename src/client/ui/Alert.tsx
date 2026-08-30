/**
 * The kit's alert: an inline message with a tone, used for every panel-level failure and for the
 * one toast this plugin raises.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Alert
 */

import type { ReactNode } from 'react'
import { IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** Message tone. */
export type AlertTone = 'default' | 'success' | 'warning' | 'destructive'

/** Everything an alert renders from. */
export interface AlertProps {
  /** Tone; defaults to `default`. */
  tone?: AlertTone | undefined
  /** A heading above the message. */
  title?: string | undefined
  /** Leading glyph; a destructive or warning alert defaults to the warning triangle. */
  icon?: ReactNode | undefined
  /** The message. */
  children: ReactNode
  /** Rendered at the end of the row: a dismiss control, a retry. */
  action?: ReactNode | undefined
  /** Additional classes. */
  className?: string | undefined
}

/** Class per tone. */
const TONES: Readonly<Record<AlertTone, string | undefined>> = {
  default: undefined,
  success: css.alertSuccess,
  warning: css.alertWarning,
  destructive: css.alertDestructive,
}

/**
 * An alert.
 * @param props - the tone, the optional heading, the message, and an optional action.
 * @returns the alert element.
 * @see {@link AlertProps}
 */
export function Alert(props: AlertProps) {
  const { tone = 'default', title, icon, children, action, className } = props
  const glyph = icon ?? (tone === 'destructive' || tone === 'warning' ? <IconWarningOutline16 /> : undefined)
  return (
    <div className={cx(css.alert, TONES[tone], className)} role={tone === 'destructive' ? 'alert' : 'status'}>
      {glyph !== undefined && <span className={css.alertIcon}>{glyph}</span>}
      <span className={css.alertBody}>
        {title !== undefined && <span className={css.alertTitle}>{title}</span>}
        {children}
      </span>
      {action}
    </div>
  )
}
