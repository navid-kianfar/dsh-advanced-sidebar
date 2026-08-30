/**
 * The kit's month grid.
 *
 * Dates are handled as local calendar days, never as instants: a task started at 23:30 belongs to
 * the day the operator saw on the clock, and comparing `Date` values directly would put it on the
 * next one for anybody east of UTC. {@link dayKey} is the comparison used everywhere.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Calendar
 */

import { useState } from 'react'
import { IconChevronLeftOutline14, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button } from './Button.tsx'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** Days in one week; the grid's column count and the week-start arithmetic both use it. */
const WEEK = 7

/** Weeks drawn, so switching months never changes the grid's height. */
const WEEKS = 6

/**
 * One local calendar day, as `YYYY-MM-DD`.
 *
 * `toISOString` is deliberately not used: it converts to UTC first, which shifts the day for most
 * of the world.
 * @param date - any instant.
 * @returns the local day it falls on.
 */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * Midnight at the start of one local day.
 * @param date - any instant.
 * @returns a new Date at 00:00 local time on the same day.
 */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * The days one month grid shows, including the leading and trailing days of its neighbours.
 * @param month - any instant inside the month.
 * @param weekStart - 0 for Sunday, 1 for Monday.
 * @returns 42 consecutive local days.
 */
export function monthGrid(month: Date, weekStart: number): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const lead = (first.getDay() - weekStart + WEEK) % WEEK
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead)
  return Array.from({ length: WEEK * WEEKS }, (_, index) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + index))
}

/** Everything the grid renders from. */
export interface CalendarProps {
  /** The selected day; absent selects nothing. */
  value: Date | undefined
  /**
   * A day was chosen.
   * @param next - midnight at the start of the chosen local day.
   */
  onValueChange: (next: Date) => void
  /** Earliest selectable day; earlier days are disabled. */
  min?: Date | undefined
  /** Latest selectable day; later days are disabled. */
  max?: Date | undefined
  /** BCP 47 tag for the month and weekday names; absent uses the browser's. */
  locale?: string | undefined
  /** 0 for Sunday, 1 for Monday; defaults to Monday. */
  weekStart?: number | undefined
  /** The clear control's text; absent hides it. */
  clearLabel?: string | undefined
  /** Clear the selection. */
  onClear?: (() => void) | undefined
  /** The today control's text. */
  todayLabel: string
  /** Accessible name of the previous-month control. */
  previousLabel: string
  /** Accessible name of the next-month control. */
  nextLabel: string
}

/**
 * A month grid.
 * @param props - the selection, the bounds, and the control labels.
 * @returns the calendar element.
 * @see {@link CalendarProps}
 */
export function Calendar(props: CalendarProps) {
  const { value, onValueChange, min, max, locale, weekStart = 1 } = props
  const { clearLabel, onClear, todayLabel, previousLabel, nextLabel } = props
  const today = startOfDay(new Date())
  const [month, setMonth] = useState(() => startOfDay(value ?? today))
  const grid = monthGrid(month, weekStart)
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month)
  const weekdayName = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  const selectedKey = value === undefined ? undefined : dayKey(value)
  const todayKey = dayKey(today)

  const shift = (delta: number): void => {
    setMonth(current => new Date(current.getFullYear(), current.getMonth() + delta, 1))
  }

  return (
    <div className={css.calendar}>
      <div className={css.calendarHead}>
        <Button size="icon" aria-label={previousLabel} onClick={() => { shift(-1) }}>
          <IconChevronLeftOutline14 />
        </Button>
        <span className={css.calendarMonth}>{monthName}</span>
        <Button size="icon" aria-label={nextLabel} onClick={() => { shift(1) }}>
          <IconChevronRightOutline14 />
        </Button>
      </div>
      <div className={css.calendarGrid} role="grid">
        {grid.slice(0, WEEK).map(day => (
          <span key={`weekday-${dayKey(day)}`} className={css.calendarWeekday}>
            {weekdayName.format(day).slice(0, 2)}
          </span>
        ))}
        {grid.map((day) => {
          const key = dayKey(day)
          const outside = day.getMonth() !== month.getMonth()
          const blocked = (min !== undefined && day < startOfDay(min)) || (max !== undefined && day > startOfDay(max))
          return (
            <button
              key={key}
              type="button"
              className={cx(
                css.day,
                outside && css.dayOutside,
                key === todayKey && css.dayToday,
                key === selectedKey && css.daySelected,
              )}
              disabled={blocked}
              aria-pressed={key === selectedKey}
              onClick={() => { onValueChange(day) }}
            >
              {day.getDate()}
            </button>
          )
        })}
      </div>
      <div className={css.calendarFoot}>
        <Button size="sm" onClick={() => { setMonth(today); onValueChange(today) }}>{todayLabel}</Button>
        {clearLabel !== undefined && onClear !== undefined && (
          <Button size="sm" onClick={onClear}>{clearLabel}</Button>
        )}
      </div>
    </div>
  )
}
