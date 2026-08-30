/**
 * The kit's button, in shadcn's variant/size vocabulary.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Button
 */

import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** Visual weight, in shadcn's names. */
export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive'

/** Control height; `icon` is the square form for a glyph with no label. */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-lg'

/** Everything a native button takes, plus the two style axes. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight; defaults to `ghost`, the toolbar form used most here. */
  variant?: ButtonVariant | undefined
  /** Control height; defaults to `md`. */
  size?: ButtonSize | undefined
  /** Rendered before the label. */
  icon?: ReactNode | undefined
  /** Marks a toggle button as pressed, which also sets `aria-pressed`. */
  active?: boolean | undefined
}

/** Class per variant, so the union stays exhaustive at the type level. */
const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  default: css.default ?? '',
  secondary: css.secondary ?? '',
  outline: css.outline ?? '',
  ghost: css.ghost ?? '',
  destructive: css.destructive ?? '',
}

/** Class per size. */
const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: css.sizeSm ?? '',
  md: css.sizeMd ?? '',
  lg: css.sizeLg ?? '',
  icon: css.sizeIcon ?? '',
  'icon-lg': css.sizeIconLg ?? '',
}

/**
 * A button.
 * @param props - the two style axes, an optional leading icon, and every native button attribute.
 * @param ref - forwarded to the button element, so a caller can anchor a layer to it.
 * @returns the button element.
 * @see {@link ButtonProps}
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const { variant = 'ghost', size = 'md', icon, active, className, children, type, ...rest } = props
  return (
    <button
      ref={ref}
      // Always stated: a button inside a form defaults to `submit`, and every button here acts.
      type={type ?? 'button'}
      className={cx(css.button, VARIANTS[variant], SIZES[size], active === true && css.buttonOn, className)}
      {...active === undefined ? {} : { 'aria-pressed': active }}
      {...rest}
    >
      {icon !== undefined && <span className={css.itemIcon}>{icon}</span>}
      {children}
    </button>
  )
})
