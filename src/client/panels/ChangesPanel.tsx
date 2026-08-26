/**
 * The Changes panel: what git reports as uncommitted in the session's working directory, with each
 * file's patch on demand.
 *
 * Read-only by design. Staging, discarding, and committing are repository writes with consequences
 * a sidebar cannot make legible, and every one of them is one keystroke away in the Terminal panel
 * beside it.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/ChangesPanel
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconCopyOutline16, IconRefreshOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitDiffResult, GitFileChange, GitStatusResult } from '../../host/types.ts'
import type { Translate } from '../contract.ts'
import { cx } from '../cx.ts'
import { PathText, transportMessage, useLatest, type PanelProps } from './shared.tsx'
import css from './Panels.module.css'

/** Which of the four groups a row belongs to; the group decides how its diff is requested. */
type Group = 'staged' | 'unstaged' | 'untracked' | 'conflicted'

/** One expanded row's diff state. */
interface DiffState {
  /** True while the request is in flight. */
  loading: boolean
  /** The patch, once it arrived. */
  result: GitDiffResult | undefined
  /** A transport failure, phrased for display. */
  error: string | undefined
}

/** Row key: a path alone is ambiguous, because the same path can be staged AND unstaged. */
function rowKey(group: Group, change: GitFileChange): string {
  return `${group}:${change.path}`
}

/** The single letter git would print for a row, taken from whichever index the group describes. */
function statusLetter(group: Group, change: GitFileChange): string {
  if (group === 'untracked') return 'U'
  if (group === 'conflicted') return '!'
  const state = group === 'staged' ? change.index : change.worktree
  switch (state) {
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'typechange': return 'T'
    default: return 'M'
  }
}

/** One unified-diff line, classified for colouring. */
function DiffLine({ line }: { line: string }) {
  const kind = line.startsWith('+++') || line.startsWith('---')
    ? 'meta'
    : line.startsWith('@@')
      ? 'hunk'
      : line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'remove'
          : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file')
            || line.startsWith('deleted file') || line.startsWith('similarity ')
            || line.startsWith('rename ') || line.startsWith('Binary files')
            ? 'meta'
            : 'context'
  return (
    <span
      className={cx(
        css.diffLine,
        kind === 'add' && css.diffAdd,
        kind === 'remove' && css.diffRemove,
        kind === 'hunk' && css.diffHunk,
        kind === 'meta' && css.diffMeta,
      )}
    >
      {line === '' ? ' ' : line}
    </span>
  )
}

/** The patch body for one expanded row. */
function Diff({ state, t }: { state: DiffState; t: Translate }) {
  if (state.loading) return <p className={css.quiet}>{t('panel.loading')}</p>
  if (state.error !== undefined) return <p className={css.error}>{state.error}</p>
  const result = state.result
  if (result === undefined) return null
  if (!result.ok) return <p className={css.error}>{result.message}</p>
  if (result.binary) return <p className={css.quiet}>{t('changes.diff.binary')}</p>
  if (result.patch.trim() === '') return <p className={css.quiet}>{t('changes.diff.empty')}</p>
  return (
    <>
      <pre className={css.diff}>
        {result.patch.split('\n').map((line, index) => (
          // eslint-disable-next-line react/no-array-index-key -- a patch line has no identity of
          // its own; the array is replaced wholesale on every reload, so the index is stable.
          <Fragment key={index}><DiffLine line={line} />{'\n'}</Fragment>
        ))}
      </pre>
      {result.truncated && (
        <p className={css.quiet}>{t('changes.diff.truncated', { n: result.patch.length })}</p>
      )}
    </>
  )
}

/**
 * The git status reading and its per-file patches.
 * @param props - the target, the translator, and the drawer's face.
 * @returns the panel body.
 * @see {@link PanelProps}
 */
export function ChangesPanel({ target, t, face }: PanelProps) {
  const [status, setStatus] = useState<GitStatusResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const [diffs, setDiffs] = useState<Readonly<Record<string, DiffState>>>({})
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef(0)
  useEffect(() => () => { window.clearTimeout(copiedTimer.current) }, [])

  const directory = target.directory
  const { gitStatus, gitDiff, copy } = face
  const latest = useLatest(t)

  useEffect(() => {
    if (directory === undefined) return
    const controller = new AbortController()
    setError(undefined)
    gitStatus(directory, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setStatus(next) },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(transportMessage(reason, latest.current))
      },
    )
    return () => { controller.abort() }
  }, [directory, generation, gitStatus, latest])

  // A reload invalidates every open patch: the row is still there, but what it showed described the
  // previous reading. Clearing is cheaper and more honest than re-fetching patches nobody expanded.
  useEffect(() => { setDiffs({}) }, [generation])

  const toggle = useCallback((group: Group, change: GitFileChange) => {
    const key = rowKey(group, change)
    setExpanded(current => (current === key ? undefined : key))
    if (directory === undefined || diffs[key] !== undefined) return
    setDiffs(current => ({ ...current, [key]: { loading: true, result: undefined, error: undefined } }))
    gitDiff({
      workspacePath: directory,
      path: change.path,
      staged: group === 'staged',
      untracked: group === 'untracked',
    }).then(
      (result) => {
        setDiffs(current => ({ ...current, [key]: { loading: false, result, error: undefined } }))
      },
      (reason: unknown) => {
        setDiffs(current => ({
          ...current,
          [key]: { loading: false, result: undefined, error: transportMessage(reason, latest.current) },
        }))
      },
    )
  }, [diffs, directory, gitDiff, latest])

  const groups = useMemo((): readonly (readonly [Group, readonly GitFileChange[]])[] => {
    if (status === undefined || !status.ok) return []
    return [
      ['conflicted', status.conflicted],
      ['staged', status.staged],
      ['unstaged', status.unstaged],
      ['untracked', status.untracked],
    ] as const
  }, [status])

  const total = groups.reduce((sum, [, rows]) => sum + rows.length, 0)

  return (
    <>
      <div className={css.toolbar}>
        {status?.ok === true && (
          <>
            <span className={css.branch}>
              {status.detached
                ? t('changes.branch.detached')
                : status.branch ?? t('changes.branch.unborn')}
            </span>
            {status.ahead > 0 && <span className={css.pill}>{t('changes.ahead', { n: status.ahead })}</span>}
            {status.behind > 0 && <span className={css.pill}>{t('changes.behind', { n: status.behind })}</span>}
            <span className={css.spacer} />
            <span className={css.quietInline}>{t('changes.count', { n: total })}</span>
          </>
        )}
        {status?.ok !== true && <span className={css.spacer} />}
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('panel.refresh')}
          title={t('panel.refresh')}
          onClick={() => { setGeneration(value => value + 1) }}
        >
          <IconRefreshOutline14 />
        </button>
      </div>

      <div className={css.scroll}>
        {error !== undefined && <p className={css.error}>{error}</p>}
        {status === undefined && error === undefined && <p className={css.quiet}>{t('panel.loading')}</p>}
        {status?.ok === false && <p className={css.error}>{status.message}</p>}
        {status?.ok === true && total === 0 && <p className={css.quiet}>{t('changes.empty')}</p>}
        {status?.ok === true && groups.map(([group, rows]) => (rows.length === 0 ? null : (
          <section key={group} className={css.group}>
            <h3 className={css.groupTitle}>
              {t(`changes.group.${group}` as 'changes.group.staged')}
              <span className={css.groupCount}>{rows.length}</span>
            </h3>
            {rows.map((change) => {
              const key = rowKey(group, change)
              const open = expanded === key
              const state = diffs[key]
              return (
                <div key={key} className={css.fileBlock}>
                  <button type="button" className={cx(css.fileRow, open && css.fileRowOpen)} onClick={() => { toggle(group, change) }}>
                    {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                    <span className={cx(css.letter, css[`letter${statusLetter(group, change)}`])}>
                      {statusLetter(group, change)}
                    </span>
                    <PathText
                      className={css.filePath}
                      value={change.oldPath === undefined ? change.path : `${change.oldPath} → ${change.path}`}
                    />
                  </button>
                  {open && (
                    <div className={css.diffBlock}>
                      {state?.result?.ok === true && !state.result.binary && state.result.patch !== '' && (
                        <button
                          type="button"
                          className={css.copyButton}
                          onClick={() => {
                            void copy(state.result?.ok === true ? state.result.patch : '').then((done) => {
                              if (!done) return
                              setCopied(true)
                              window.clearTimeout(copiedTimer.current)
                              copiedTimer.current = window.setTimeout(() => { setCopied(false) }, 1_500)
                            })
                          }}
                        >
                          <IconCopyOutline16 />
                          {copied ? t('changes.diff.copied') : t('changes.diff.copy')}
                        </button>
                      )}
                      <Diff state={state ?? { loading: true, result: undefined, error: undefined }} t={t} />
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        )))}
        {status?.ok === true && status.truncated && (
          <p className={css.quiet}>{t('changes.truncated', { n: total })}</p>
        )}
      </div>
    </>
  )
}
