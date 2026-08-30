/**
 * The kit's badge — the tag used for a branch name, a file status letter, a port, or a capability
 * verdict.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Badge
 */

import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** Badge tone. The three state tones carry meaning; the first three are neutral. */
export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive'

/** Everything a span takes, plus the tone. */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Tone; defaults to `secondary`. */
  variant?: BadgeVariant | undefined
  /** Render the text monospaced and allow it to clip, for a path or a command. */
  code?: boolean | undefined
  /** Rendered before the text. */
  icon?: ReactNode | undefined
}

/** Class per tone. */
const VARIANTS: Readonly<Record<BadgeVariant, string>> = {
  default: css.badgeDefault ?? '',
  secondary: css.badgeSecondary ?? '',
  outline: css.badgeOutline ?? '',
  success: css.badgeSuccess ?? '',
  warning: css.badgeWarning ?? '',
  destructive: css.badgeDestructive ?? '',
}

/**
 * A badge.
 * @param props - the tone, the optional monospace form, an optional icon, and span attributes.
 * @returns the badge element.
 * @see {@link BadgeProps}
 */
export function Badge(props: BadgeProps) {
  const { variant = 'secondary', code = false, icon, className, children, ...rest } = props
  return (
    <span className={cx(css.badge, VARIANTS[variant], code && css.badgeCode, className)} {...rest}>
      {icon}
      {children}
    </span>
  )
}
