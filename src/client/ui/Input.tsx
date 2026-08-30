/**
 * The kit's text controls: a single-line input and a textarea, both in shadcn's bordered form.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Input
 */

import { forwardRef } from 'react'
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** Every native input attribute, plus the two shapes this package needs. */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Render the value monospaced, for a path, a command, or a URL. */
  code?: boolean | undefined
}

/**
 * A single-line input.
 * @param props - the optional monospace form and every native input attribute.
 * @param ref - forwarded to the input element.
 * @returns the input element.
 * @see {@link InputProps}
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const { code = false, className, type, ...rest } = props
  return (
    <input
      ref={ref}
      type={type ?? 'text'}
      className={cx(css.input, code && css.inputCode, type === 'number' && css.inputNumber, className)}
      {...rest}
    />
  )
})

/**
 * A multi-line input.
 * @param props - every native textarea attribute.
 * @param ref - forwarded to the textarea element.
 * @returns the textarea element.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(css.input, css.textarea, className)} {...rest} />
  },
)
