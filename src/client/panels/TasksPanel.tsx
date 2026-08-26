/**
 * The Background tasks panel: this session's `ctx.jobs` records, with Stop and the output of a
 * settled one.
 *
 * The list is not fetched. The Host already pushes `session/jobs` frames that the Web Client folds
 * into its `jobsBySession` mirror, so this panel reads the same live data the session header's job
 * chip reads — it appears, moves, and empties without a single request. Only the two verbs the
 * mirror has no wire for go over this plugin's endpoint.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/TasksPanel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JobView, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconStopFill16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AdvancedSidebarSettings, TaskOutputResult } from '../../host/types.ts'
import type { Translate } from '../contract.ts'
import { cx } from '../cx.ts'
import { transportMessage, type PanelProps } from './shared.ts'
import css from './Panels.module.css'

/** Stable empty list, so a session with no tasks keeps one array identity across renders. */
const NO_TASKS: readonly JobView[] = []

/** How often the elapsed clock advances while something is live. */
const TICK_MS = 1_000

/** One expanded row's output state. */
interface OutputState {
  /** True while the request is in flight. */
  loading: boolean
  /** The Host's answer. */
  result: TaskOutputResult | undefined
  /** A transport failure, phrased for display. */
  error: string | undefined
}

/** A task the registry still holds open, and whose duration therefore ticks. */
function isLive(task: JobView): boolean {
  return task.status === 'running' || task.status === 'stopping'
}

/**
 * Status marker semantics. `stopping` and `killed` share the attention colour: both mean the work
 * ended, or is ending, on request rather than on its own.
 * @param status - the wire status.
 * @returns the dot state.
 */
function dotState(status: JobView['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return 'done'
    case 'killed': return 'warning'
    default: return 'error'
  }
}

/**
 * Elapsed time in at most two adjacent units.
 * @param elapsedMs - the span.
 * @param t - the namespace translator.
 * @returns the formatted duration.
 */
function formatDuration(elapsedMs: number, t: Translate): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('tasks.duration.hours', { hours, minutes })
  if (minutes > 0) return t('tasks.duration.minutes', { minutes, seconds })
  return t('tasks.duration.seconds', { seconds })
}

/**
 * Live rows first in start order, then settled rows newest-first. Two tasks that settled in the
 * same millisecond fall back to start order, so the sort never depends on map iteration.
 * @param tasks - the mirror's list.
 * @returns the ordered rows.
 */
function ordered(tasks: readonly JobView[]): JobView[] {
  return [...tasks].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/** The panel's own props: the drawer's share plus the two facts only the drawer can supply. */
export interface TasksPanelProps extends PanelProps {
  /** The global session feed the mirror rides on. */
  useSessions: SnapshotSelectorHook<SessionListState>
  /** The resolved settings section, which decides whether Stop and output are offered. */
  settings: AdvancedSidebarSettings | undefined
}

/**
 * The task list, Stop, and the output of a settled task.
 * @param props - the target, the translator, the drawer's face, the session feed, and the settings.
 * @returns the panel body.
 * @see {@link TasksPanelProps}
 */
export function TasksPanel({ target, t, face, useSessions, settings }: TasksPanelProps) {
  const { taskKill, taskOutput, notify } = face
  const sessionId = target.sessionId
  const tasks = useSessions((state: SessionListState) =>
    state.jobsBySession[sessionId as keyof SessionListState['jobsBySession']]) ?? NO_TASKS
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [outputs, setOutputs] = useState<Readonly<Record<string, OutputState>>>({})
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const rows = useMemo(() => ordered(tasks), [tasks])
  const liveCount = useMemo(() => tasks.filter(isLive).length, [tasks])

  // The clock runs only while something moves: a list of finished tasks re-renders never.
  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { window.clearInterval(timer) }
  }, [liveCount])

  const load = useCallback((taskId: string) => {
    setOutputs(current => ({ ...current, [taskId]: { loading: true, result: undefined, error: undefined } }))
    taskOutput(sessionId, taskId).then(
      (result) => {
        setOutputs(current => ({ ...current, [taskId]: { loading: false, result, error: undefined } }))
      },
      (reason: unknown) => {
        setOutputs(current => ({
          ...current,
          [taskId]: { loading: false, result: undefined, error: transportMessage(reason, t) },
        }))
      },
    )
  }, [sessionId, taskOutput, t])

  const stop = useCallback((taskId: string) => {
    setBusy(taskId)
    taskKill(sessionId, taskId).then(
      (result) => {
        setBusy(undefined)
        if (!result.ok) { notify('error', result.message); return }
        notify('info', result.outcome === 'requested' ? t('tasks.stopped') : t('tasks.alreadyFinished'))
        // The registry marks a killed record reported, which is exactly the condition that makes
        // its output readable — so a Stop is the moment to offer it.
        if (expanded === taskId) load(taskId)
      },
      (reason: unknown) => {
        setBusy(undefined)
        notify('error', transportMessage(reason, t))
      },
    )
  }, [expanded, load, notify, sessionId, taskKill, t])

  const canStop = settings?.allowTaskKill === true
  const canRead = settings?.showTaskOutput === true

  return (
    <div className={css.scroll}>
      {rows.length === 0 && <p className={css.quiet}>{t('tasks.empty')}</p>}
      {rows.map((task) => {
        const live = isLive(task)
        const elapsed = live ? now - task.startedAt : (task.finishedAt ?? task.startedAt) - task.startedAt
        const open = expanded === task.id
        const output = outputs[task.id]
        return (
          <div key={task.id} className={css.taskBlock}>
            <div className={cx(css.taskRow, !live && css.taskRowSettled)}>
              {canRead
                ? (
                  <button
                    type="button"
                    className={css.taskDisclosure}
                    aria-expanded={open}
                    aria-label={t('tasks.output')}
                    onClick={() => {
                      const next = open ? undefined : task.id
                      setExpanded(next)
                      if (next !== undefined && outputs[task.id] === undefined) load(task.id)
                    }}
                  >
                    {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                  </button>
                )
                : <span className={css.taskDisclosureSpacer} />}
              <StateDot state={dotState(task.status)} className={css.taskDot} />
              <span className={css.taskKind}>{task.kind}</span>
              <span className={css.taskLabel} title={task.label}>{task.label}</span>
              <span className={css.taskStatus} title={task.detail ?? undefined}>
                {task.detail ?? t(`tasks.status.${task.status}` as 'tasks.status.running')}
              </span>
              <span className={css.taskDuration}>{formatDuration(elapsed, t)}</span>
              {canStop && live && (
                <button
                  type="button"
                  className={css.toolButton}
                  aria-label={t('tasks.stop')}
                  title={t('tasks.stop')}
                  disabled={busy === task.id}
                  onClick={() => { stop(task.id) }}
                >
                  <IconStopFill16 />
                </button>
              )}
            </div>
            {open && (
              <div className={css.taskOutput}>
                {output?.loading === true && <p className={css.quiet}>{t('panel.loading')}</p>}
                {output?.error !== undefined && <p className={css.error}>{output.error}</p>}
                {output?.result?.ok === false && <p className={css.error}>{output.result.message}</p>}
                {output?.result?.ok === true && !output.result.readable && (
                  <p className={css.quiet}>{output.result.reason ?? t('tasks.output.withheld')}</p>
                )}
                {output?.result?.ok === true && output.result.readable && (
                  output.result.text === ''
                    ? <p className={css.quiet}>{t('tasks.output.empty')}</p>
                    : <pre className={css.terminalText}>{output.result.text}</pre>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
