/**
 * The Terminal panel: an interactive shell of the operator's own, in the session's working
 * directory.
 *
 * Output arrives by polling, because an out-of-tree plugin has no host-to-client push channel: the
 * panel holds the whole-stream offset it has already rendered and asks for whatever came after it.
 * The offset is what makes a reopened panel resume the same shell mid-scrollback instead of showing
 * a blank screen, and what makes a dropped poll cost nothing but latency.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/TerminalPanel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { IconRefreshOutline14, IconStopFill16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalReadSuccess } from '../../host/types.ts'
import { cx } from '../cx.ts'
import { TerminalScreen } from '../terminal-screen.ts'
import { transportMessage, type PanelProps } from './shared.ts'
import css from './Panels.module.css'

/** How often the panel asks for new output while the shell is alive. */
const POLL_MS = 220

/** Retained display lines. Well past a screen, and far short of a memory concern. */
const SCREEN_LINES = 5_000

/** Monospace cell width used to turn the rendered box into a column count. */
const CELL_WIDTH = 7.8

/** Monospace line height used to turn the rendered box into a row count. */
const CELL_HEIGHT = 18

/** Escape, the prefix of every cursor key this panel forwards. */
const ESC = '\u001B'

/** Keys with no printable form, mapped to the bytes a terminal expects. */
const KEYS: Readonly<Record<string, string>> = {
  Enter: '\r',
  Backspace: '\u007F',
  Tab: '\t',
  Escape: ESC,
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  Delete: `${ESC}[3~`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
}

/** What the panel knows about its shell. */
interface Session {
  /** The Host handle. */
  terminalId: string
  /** Which shell answered. */
  shell: string
}

/**
 * The shell, its output, and the keyboard.
 * @param props - the target, the translator, and the drawer's face.
 * @returns the panel body.
 * @see {@link PanelProps}
 */
export function TerminalPanel({ target, t, face }: PanelProps) {
  const { terminalOpen, terminalRead, terminalWrite, terminalInterrupt, terminalClose } = face
  const directory = target.directory
  const [session, setSession] = useState<Session | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [exit, setExit] = useState<string | undefined>(undefined)
  const [lossy, setLossy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const screen = useMemo(() => new TerminalScreen(SCREEN_LINES), [])
  const offset = useRef(0)
  const viewRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // Allocation is keyed on the directory and the restart counter, so a Restart tears the previous
  // shell down through this effect's own cleanup rather than leaving two alive.
  useEffect(() => {
    if (directory === undefined) return
    let live = true
    let allocated: string | undefined
    const rect = boxRef.current?.getBoundingClientRect()
    const cols = Math.max(20, Math.floor((rect?.width ?? 420) / CELL_WIDTH))
    const rows = Math.max(5, Math.floor((rect?.height ?? 360) / CELL_HEIGHT))
    screen.clear()
    offset.current = 0
    setExit(undefined)
    setLossy(false)
    setError(undefined)
    setSession(undefined)
    setRevision(value => value + 1)

    terminalOpen(directory, cols, rows).then(
      (result) => {
        if (!live) return
        if (!result.ok) { setError(result.message); return }
        allocated = result.terminalId
        setSession({ terminalId: result.terminalId, shell: result.shell })
      },
      (reason: unknown) => { if (live) setError(transportMessage(reason, t)) },
    )
    return () => {
      live = false
      // The shell is this panel's, so closing the panel closes it: leaving one behind would keep a
      // process alive that nothing can reach and that only plugin teardown would ever reap.
      if (allocated !== undefined) void terminalClose(allocated)
    }
  }, [directory, attempt, screen, terminalOpen, terminalClose, t])

  const terminalId = session?.terminalId
  const finished = exit !== undefined

  // One poll chain rather than an interval: a slow read must not queue a second one behind it, and
  // the chain stops on its own once the shell has exited and its final delta has been drained.
  useEffect(() => {
    if (terminalId === undefined || finished) return
    let live = true
    let timer = 0
    const settle = (read: TerminalReadSuccess): void => {
      if (read.text !== '') {
        screen.write(read.text)
        setRevision(value => value + 1)
      }
      if (read.lossy) setLossy(true)
      offset.current = read.nextOffset
      if (!read.running) {
        setExit(read.signal === null || read.signal === undefined
          ? t('terminal.exited', { code: read.exitCode ?? 0 })
          : t('terminal.exitedSignal', { signal: read.signal }))
      }
    }
    const tick = (): void => {
      terminalRead(terminalId, offset.current).then(
        (result) => {
          if (!live) return
          if (result.ok) settle(result)
          else setError(result.message)
          timer = window.setTimeout(tick, POLL_MS)
        },
        (reason: unknown) => {
          if (!live) return
          setError(transportMessage(reason, t))
          timer = window.setTimeout(tick, POLL_MS)
        },
      )
    }
    tick()
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [terminalId, finished, screen, terminalRead, t])

  // Follow the tail unless the operator has scrolled up to read something; a terminal that yanks
  // the viewport back on every poll cannot be read while it is busy.
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40
    if (atBottom) view.scrollTop = view.scrollHeight
  }, [revision])

  const send = useCallback((data: string) => {
    if (terminalId === undefined) return
    void terminalWrite(terminalId, data).then((result) => {
      if (!result.ok) setError(result.message)
    }, (reason: unknown) => { setError(transportMessage(reason, t)) })
  }, [terminalId, terminalWrite, t])

  // Keystrokes are forwarded from a hidden textarea rather than a contenteditable screen: the
  // browser then owns IME composition, and only committed text reaches the shell.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      if (terminalId !== undefined) void terminalInterrupt(terminalId)
      return
    }
    const control = KEYS[event.key]
    if (control === undefined) return
    event.preventDefault()
    send(control)
  }

  const lines = screen.snapshot()
  const idle = terminalId === undefined || finished

  return (
    <>
      <div className={css.toolbar}>
        <span className={css.quietInline} title={session?.shell}>{session?.shell ?? t('terminal.starting')}</span>
        <span className={css.spacer} />
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('terminal.interrupt')}
          title={t('terminal.interrupt')}
          disabled={idle}
          onClick={() => { if (terminalId !== undefined) void terminalInterrupt(terminalId) }}
        >
          <IconStopFill16 />
        </button>
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('terminal.clear')}
          title={t('terminal.clear')}
          onClick={() => { screen.clear(); setRevision(value => value + 1) }}
        >
          <IconTrashOutline16 />
        </button>
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('terminal.restart')}
          title={t('terminal.restart')}
          onClick={() => { setAttempt(value => value + 1) }}
        >
          <IconRefreshOutline14 />
        </button>
      </div>

      <div
        ref={boxRef}
        className={css.terminalBox}
        onClick={() => { inputRef.current?.focus() }}
        role="presentation"
      >
        <div ref={viewRef} className={css.terminalView}>
          {lossy && <p className={css.quiet}>{t('terminal.lossy')}</p>}
          <pre className={css.terminalText}>{lines.join('\n')}</pre>
          {error !== undefined && <p className={css.error}>{error}</p>}
          {exit !== undefined && <p className={css.quiet}>{exit}</p>}
        </div>
        <textarea
          ref={inputRef}
          className={css.terminalInput}
          aria-label={t('terminal.inputAria')}
          spellCheck={false}
          autoComplete="off"
          disabled={idle}
          value=""
          onKeyDown={onKeyDown}
          onChange={(event) => {
            // The field is deliberately always empty: every committed character is forwarded and
            // the shell's own echo is what appears on the screen above.
            const text = event.target.value
            if (text !== '') send(text)
          }}
        />
        <p className={cx(css.terminalHint, idle && css.terminalHintOff)}>{t('terminal.hint')}</p>
      </div>
    </>
  )
}
