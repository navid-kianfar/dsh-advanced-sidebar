/**
 * The Changes panel: what git reports as uncommitted in the session's working directory, each
 * file's patch on demand, and the two writes that turn a reading into a commit.
 *
 * Staging and committing are offered; DISCARDING is not. Stage, unstage, and commit are all
 * recoverable — the working tree is untouched by the first two, and a commit stays in the reflog —
 * while discarding destroys uncommitted work with nothing left to recover it from. A sidebar is the
 * wrong place for the one irreversible verb in the set, and `git restore` is a keystroke away in
 * the Terminal panel beside it.
 *
 * Every write returns the reading that follows it, so the lists never lag a round trip behind the
 * index they describe.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/ChangesPanel
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconCopyOutline16, IconLoadingOutline16, IconRefreshOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitDiffResult, GitFileChange, GitStatusResult, GitStatusSuccess } from '../../host/types.ts'
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
  const { gitStatus, gitDiff, gitStage, gitUnstage, gitCommit, copy, notify } = face
  const latest = useLatest(t)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  /** The write in flight; one at a time, because two overlapping index writes would race. */
  const [writing, setWriting] = useState(false)

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
  const write = status?.ok === true ? status.write : undefined
  const stagedCount = status?.ok === true ? status.staged.length : 0

  /**
   * Run one index write and adopt the reading it returns.
   * @param run - the endpoint call.
   */
  const commitWrite = useCallback((run: () => Promise<{ ok: true; status: GitStatusSuccess } | { ok: false; message: string }>) => {
    setWriting(true)
    run().then(
      (result) => {
        setWriting(false)
        if (!result.ok) { notify('error', result.message); return }
        setStatus(result.status)
        // The patches described the previous index. Keeping them would show a staged file's diff
        // as if it were still unstaged, so they go with the reading they belonged to.
        setDiffs({})
        setExpanded(undefined)
      },
      (reason: unknown) => {
        setWriting(false)
        notify('error', transportMessage(reason, latest.current))
      },
    )
  }, [notify, latest])

  const stage = useCallback((paths: readonly string[]) => {
    if (directory === undefined || paths.length === 0) return
    commitWrite(() => gitStage(directory, paths))
  }, [commitWrite, directory, gitStage])

  const unstage = useCallback((paths: readonly string[]) => {
    if (directory === undefined || paths.length === 0) return
    commitWrite(() => gitUnstage(directory, paths))
  }, [commitWrite, directory, gitUnstage])

  const record = useCallback(() => {
    if (directory === undefined) return
    setWriting(true)
    gitCommit(directory, message, amend).then(
      (result) => {
        setWriting(false)
        if (!result.ok) { notify('error', result.message); return }
        setStatus(result.status)
        setDiffs({})
        setExpanded(undefined)
        setMessage('')
        setAmend(false)
        notify('info', latest.current('changes.commit.done', { commit: result.commit, subject: result.subject }))
        // A hook's advice is worth surfacing on its own: it explains a commit that succeeded but
        // reformatted something, which the success line alone would hide.
        if (result.notes !== '') notify('info', result.notes)
      },
      (reason: unknown) => {
        setWriting(false)
        notify('error', transportMessage(reason, latest.current))
      },
    )
  }, [amend, directory, gitCommit, message, notify, latest])

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

      {write?.canCommit === true && (
        <div className={css.commitBox}>
          <textarea
            className={css.commitMessage}
            aria-label={t('changes.commit.message')}
            placeholder={t('changes.commit.placeholder')}
            rows={2}
            spellCheck={false}
            disabled={writing}
            value={message}
            onChange={(event) => { setMessage(event.target.value) }}
            onKeyDown={(event) => {
              // The message is multi-line, so plain Enter must insert one; the modifier chord is
              // what every commit box in every editor uses to send.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                if (!writing && message.trim() !== '') record()
              }
            }}
          />
          <div className={css.commitRow}>
            <label className={css.commitAmend}>
              <input
                type="checkbox"
                className={css.commitCheckbox}
                disabled={writing}
                checked={amend}
                onChange={(event) => { setAmend(event.target.checked) }}
              />
              {t('changes.commit.amend')}
            </label>
            <span className={css.spacer} />
            <button
              type="button"
              className={css.commitButton}
              // Amending has something to record with an empty index; an ordinary commit does not.
              disabled={writing || message.trim() === '' || (stagedCount === 0 && !amend)}
              onClick={record}
            >
              {writing ? <IconLoadingOutline16 /> : null}
              {stagedCount === 0
                ? t('changes.commit')
                // Counted copy takes one key per plural form: English needs "1 file" against
                // "2 files", and a single template would print "1 files" for the commonest case.
                : t(stagedCount === 1 ? 'changes.commit.count.one' : 'changes.commit.count.other', { n: stagedCount })}
            </button>
          </div>
          <p className={css.commitHint}>
            {write.author === undefined
              ? t('changes.commit.noIdentity')
              : t('changes.commit.author', { author: write.author })}
          </p>
        </div>
      )}

      <div className={css.scroll}>
        {error !== undefined && <p className={css.error}>{error}</p>}
        {status === undefined && error === undefined && <p className={css.quiet}>{t('panel.loading')}</p>}
        {status?.ok === false && <p className={css.error}>{status.message}</p>}
        {status?.ok === true && total === 0 && <p className={css.quiet}>{t('changes.empty')}</p>}
        {status?.ok === true && write?.canStage === false && total > 0 && (
          <p className={css.quiet}>{t('changes.readOnly')}</p>
        )}
        {status?.ok === true && groups.map(([group, rows]) => (rows.length === 0 ? null : (
          <section key={group} className={css.group}>
            <h3 className={css.groupTitle}>
              {t(`changes.group.${group}` as 'changes.group.staged')}
              <span className={css.groupCount}>{rows.length}</span>
              {write?.canStage === true && group !== 'conflicted' && (
                <button
                  type="button"
                  className={css.groupAction}
                  disabled={writing}
                  onClick={() => {
                    const paths = rows.map(row => row.path)
                    if (group === 'staged') unstage(paths)
                    else stage(paths)
                  }}
                >
                  {group === 'staged' ? t('changes.unstage.all') : t('changes.stage.all')}
                </button>
              )}
            </h3>
            {rows.map((change) => {
              const key = rowKey(group, change)
              const open = expanded === key
              const state = diffs[key]
              return (
                <div key={key} className={cx(css.fileBlock, open && css.fileBlockOpen)}>
                  <div className={css.fileLine}>
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
                    {write?.canStage === true && group !== 'conflicted' && (
                      <button
                        type="button"
                        className={css.rowAction}
                        aria-label={group === 'staged' ? t('changes.unstage') : t('changes.stage')}
                        title={group === 'staged' ? t('changes.unstage') : t('changes.stage')}
                        disabled={writing}
                        onClick={() => {
                          if (group === 'staged') unstage([change.path])
                          else stage([change.path])
                        }}
                      >
                        {group === 'staged' ? <IconCloseOutline16 /> : <IconCheckOutline16 />}
                      </button>
                    )}
                  </div>
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
