/**
 * The Terminal panel: an interactive shell of the operator's own, in the session's working
 * directory.
 *
 * The screen is a real terminal emulator (`@xterm/xterm`), not an approximation. That is not
 * gold-plating: an interactive shell redraws its prompt with cursor addressing on every keystroke,
 * and a screen model that understands only carriage returns and erase-line renders a login shell's
 * prompt as overwritten fragments. Colour, line editing, history recall, and full-screen programs
 * all come with the emulator; nothing here reimplements them.
 *
 * Output arrives by polling, because an out-of-tree plugin has no host-to-client push channel: the
 * panel holds the whole-stream offset it has already written into the emulator and asks for
 * whatever came after it. The offset is what makes a reopened panel replay the retained scrollback
 * instead of showing a blank screen, and what makes a dropped poll cost nothing but latency.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/TerminalPanel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { IconRefreshOutline14, IconStopFill16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import '@xterm/xterm/css/xterm.css'
import type { TerminalReadSuccess } from '../../host/types.ts'
import { transportMessage, useLatest, type PanelProps } from './shared.tsx'
import css from './Panels.module.css'

/** How often the panel asks for new output while the shell is alive. */
const POLL_MS = 200

/** Retained scrollback rows inside the emulator. */
const SCROLLBACK = 5_000

/** The byte Ctrl+C produces; intercepted so an interrupt becomes a signal rather than data. */
const ETX = '\u0003'

/**
 * The emulator's palette, resolved from the app's own tokens.
 *
 * xterm paints its own canvas and cannot inherit a CSS colour, so the theme is read from the
 * document at mount. Reading the computed value rather than naming a literal is what makes the
 * panel follow the app's light/dark setting instead of pinning one of them.
 * @param host - the element the terminal will be opened in.
 * @returns the resolved theme.
 */
function paletteOf(host: HTMLElement): {
  background: string; foreground: string; cursor: string; selectionBackground: string
} {
  const style = getComputedStyle(host)
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    background: read('--dsw-alias-bg-layer-1', '#00000000'),
    foreground: read('--dsw-alias-label-primary', '#e6e6e6'),
    cursor: read('--dsw-alias-brand-primary', '#7aa2f7'),
    selectionBackground: read('--dsw-alias-bg-multi-select', '#5a7cff4d'),
  }
}

/** What the panel knows about its shell. */
interface Session {
  /** The Host handle. */
  terminalId: string
  /** Which shell answered. */
  shell: string
}

/**
 * The shell, its screen, and the keyboard.
 * @param props - the target, the translator, and the drawer's face.
 * @returns the panel body.
 * @see {@link PanelProps}
 */
export function TerminalPanel({ target, t, face }: PanelProps) {
  const { terminalOpen, terminalRead, terminalWrite, terminalInterrupt, terminalClose } = face
  const directory = target.directory
  const latest = useLatest(t)
  const [session, setSession] = useState<Session | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [exit, setExit] = useState<string | undefined>(undefined)
  const [lossy, setLossy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const offset = useRef(0)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  /** The size the emulator measured before the shell was started; the PTY is fixed to it. */
  const geometry = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 })

  /** Re-measure the emulator, tolerating a host element that has no layout box yet. */
  const refit = useCallback(() => {
    try {
      fitRef.current?.fit()
    } catch {
      // `fit()` throws while the host has no layout box — the drawer closing mid-observation, or a
      // measurement taken before the panel is laid out. There is nothing to fit to in that state,
      // and the next observation measures again.
    }
  }, [])

  // The emulator is created once per mount and disposed with it. It is deliberately NOT recreated
  // for a restart: the shell changes, the screen it draws on does not.
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const term = new Terminal({
      scrollback: SCROLLBACK,
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.2,
      fontFamily: getComputedStyle(host).getPropertyValue('--ds-font-family-code').trim() || 'monospace',
      theme: paletteOf(host),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit
    refit()
    geometry.current = { cols: term.cols, rows: term.rows }

    // The emulator's own size follows the drawer, so rendered rows stay readable when the panel is
    // resized. The SHELL's size does not follow: the subprocess seam exposes no resize verb, so a
    // program that laid its output out for the original width keeps that layout until Restart
    // allocates a shell at the new one.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refit)
    observer?.observe(host)
    return () => {
      observer?.disconnect()
      term.dispose()
      termRef.current = undefined
      fitRef.current = undefined
    }
  }, [refit])

  // Allocation is keyed on the directory and the restart counter, so a Restart tears the previous
  // shell down through this effect's own cleanup rather than leaving two alive. The translator is
  // deliberately absent from the dependencies — a language switch must not kill a running shell.
  useEffect(() => {
    if (directory === undefined) return
    let live = true
    let allocated: string | undefined
    const term = termRef.current
    refit()
    if (term !== undefined) {
      term.reset()
      geometry.current = { cols: term.cols, rows: term.rows }
    }
    offset.current = 0
    setExit(undefined)
    setLossy(false)
    setError(undefined)
    setSession(undefined)

    terminalOpen(directory, geometry.current.cols, geometry.current.rows).then(
      (result) => {
        if (!result.ok) { if (live) setError(result.message); return }
        // The allocation can settle AFTER this effect was torn down — the panel closed, or the
        // directory changed, while the shell was still being started. The cleanup below cannot
        // close a handle it never saw, so a terminal arriving late closes itself here instead of
        // leaking a shell nothing can reach.
        if (!live) { void terminalClose(result.terminalId); return }
        allocated = result.terminalId
        setSession({ terminalId: result.terminalId, shell: result.shell })
      },
      (reason: unknown) => { if (live) setError(transportMessage(reason, latest.current)) },
    )
    return () => {
      live = false
      // The shell is this panel's, so closing the panel closes it: leaving one behind would keep a
      // process alive that nothing can reach and that only plugin teardown would ever reap.
      if (allocated !== undefined) void terminalClose(allocated)
    }
  }, [directory, attempt, refit, terminalOpen, terminalClose, latest])

  const terminalId = session?.terminalId
  const finished = exit !== undefined

  // One poll chain rather than an interval: a slow read must not queue a second one behind it, and
  // the chain stops on its own once the shell has exited and its final delta has been drained.
  useEffect(() => {
    if (terminalId === undefined || finished) return
    let live = true
    let timer = 0
    const settle = (read: TerminalReadSuccess): void => {
      if (read.text !== '') termRef.current?.write(read.text)
      if (read.lossy) setLossy(true)
      offset.current = read.nextOffset
      if (!read.running) {
        setExit(read.signal === null || read.signal === undefined
          ? latest.current('terminal.exited', { code: read.exitCode ?? 0 })
          : latest.current('terminal.exitedSignal', { signal: read.signal }))
      }
    }
    const tick = (): void => {
      terminalRead(terminalId, offset.current).then(
        (result) => {
          if (!live) return
          if (result.ok) {
            settle(result)
          } else {
            setError(result.message)
            // A handle the Host no longer knows will never be known again — the shell was closed
            // from elsewhere, or the plugin reloaded. Re-arming would poll a dead id forever.
            if (result.code === 'unknown-terminal') { live = false; return }
          }
          timer = window.setTimeout(tick, POLL_MS)
        },
        (reason: unknown) => {
          if (!live) return
          setError(transportMessage(reason, latest.current))
          timer = window.setTimeout(tick, POLL_MS)
        },
      )
    }
    tick()
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [terminalId, finished, terminalRead, latest])

  const send = useCallback((data: string) => {
    if (terminalId === undefined) return
    void terminalWrite(terminalId, data).then((result) => {
      if (!result.ok) setError(result.message)
    }, (reason: unknown) => { setError(transportMessage(reason, latest.current)) })
  }, [terminalId, terminalWrite, latest])

  // Keystrokes go straight from the emulator to the shell. Ctrl+C is intercepted so it reaches the
  // FOREGROUND PROCESS GROUP as a signal rather than as a byte the shell may be ignoring — which is
  // the difference between interrupting a running command and doing nothing.
  useEffect(() => {
    const term = termRef.current
    if (term === undefined || terminalId === undefined || finished) return
    const data = term.onData((chunk) => {
      if (chunk === ETX) {
        void terminalInterrupt(terminalId)
        return
      }
      send(chunk)
    })
    // Anything the emulator classifies as binary rather than text still belongs to the shell.
    const binary = term.onBinary((chunk) => { send(chunk) })
    return () => {
      data.dispose()
      binary.dispose()
    }
  }, [terminalId, finished, send, terminalInterrupt])

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
          onClick={() => { termRef.current?.clear() }}
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

      {lossy && <p className={css.quiet}>{t('terminal.lossy')}</p>}
      {error !== undefined && <p className={css.error}>{error}</p>}
      {exit !== undefined && <p className={css.quiet}>{exit}</p>}
      <div
        ref={hostRef}
        className={css.terminalBox}
        aria-label={t('terminal.inputAria')}
        onClick={() => { termRef.current?.focus() }}
        role="presentation"
      />
    </>
  )
}
