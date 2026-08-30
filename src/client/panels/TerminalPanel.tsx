/**
 * The Terminal panel: interactive shells of the operator's own, in the session's working directory.
 *
 * There are as many as the Host's `maxTerminals` allows, on a tab strip. Each tab is a separate
 * `spawnTerminal` allocation with its own emulator, its own poll chain, and its own lifetime; the
 * handles live in the shared controller rather than in this component, so switching to another
 * panel or closing the dock leaves the shells running exactly as hiding a terminal pane in an
 * editor does. A reopened tab replays instead of restarting, because the Host retains each shell's
 * scrollback and the panel asks for it from offset zero.
 *
 * The screen is a real terminal emulator (`@xterm/xterm`), not an approximation. That is not
 * gold-plating: an interactive shell redraws its prompt with cursor addressing on every keystroke,
 * and a screen model that understands only carriage returns and erase-line renders a login shell's
 * prompt as overwritten fragments. Colour, line editing, history recall, and full-screen programs
 * all come with the emulator; nothing here reimplements them.
 *
 * Output arrives by polling, because an out-of-tree plugin has no host-to-client push channel: each
 * view holds the whole-stream offset it has already written into its emulator and asks for whatever
 * came after it.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/TerminalPanel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import {
  IconPlusOutline16, IconRefreshOutline14, IconStopFill16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import '@xterm/xterm/css/xterm.css'
import type { AdvancedSidebarSettings, TerminalReadSuccess } from '../../host/types.ts'
import type { SidebarState, TerminalTab } from '../controller.ts'
import { terminalKey } from '../controller.ts'
import { Alert, Badge, Button, Tabs } from '../ui/index.ts'
import { cx } from '../cx.ts'
import { transportMessage, useLatest, type PanelProps } from './shared.tsx'
import css from './Panels.module.css'

/** How often a view asks for new output while its shell is alive. */
const POLL_MS = 200

/** Retained scrollback rows inside one emulator. */
const SCROLLBACK = 5_000

/** The byte Ctrl+C produces; intercepted so an interrupt becomes a signal rather than data. */
const ETX = '\u0003'

/** Terminals a Host allows by default, used only until its settings answer. */
const DEFAULT_MAX_TERMINALS = 4

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

/**
 * The trailing component of a shell path, for a tab's tooltip.
 * @param shell - the executable the Host started; absent while it is being allocated.
 * @returns the basename, or an empty string.
 */
function shellName(shell: string | undefined): string {
  if (shell === undefined) return ''
  const at = Math.max(shell.lastIndexOf('/'), shell.lastIndexOf('\\'))
  return at < 0 ? shell : shell.slice(at + 1)
}

/** What one tab's screen is handed. */
interface TerminalViewProps extends PanelProps {
  /** The tab this view renders. */
  tab: TerminalTab
  /** The terminal group this tab belongs to. */
  groupKey: string
  /** The directory the shell is started in. */
  directory: string
  /** Whether this tab is the one showing; an inactive view stays mounted and laid out. */
  active: boolean
}

/**
 * One shell: its screen, its keyboard, and the toolbar acting on it.
 * @param props - the tab, its group, the directory, and the dock's face.
 * @returns the view.
 * @see {@link TerminalViewProps}
 */
function TerminalView({ tab, groupKey, directory, active, t, face }: TerminalViewProps) {
  const { terminalOpen, terminalRead, terminalWrite, terminalInterrupt, terminalClose, settleTerminal } = face
  const latest = useLatest(t)
  const [exit, setExit] = useState<string | undefined>(undefined)
  const [lossy, setLossy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const offset = useRef(0)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  /** The size the emulator measured before the shell was started; the PTY is fixed to it. */
  const geometry = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 })
  /** Identifies the current attempt, so an allocation this view has superseded closes itself. */
  const token = useRef(0)
  /** True while an attempt change is what is tearing the allocation effect down. */
  const restarting = useRef(false)
  /** The handle this tab already had at mount; a re-attach must not allocate a second shell. */
  const attached = useRef(tab.terminalId)

  /** Re-measure the emulator, tolerating a host element that has no layout box yet. */
  const refit = useCallback(() => {
    try {
      fitRef.current?.fit()
    } catch {
      // `fit()` throws while the host has no layout box — the dock closing mid-observation, or a
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

    // The emulator's own size follows the dock, so rendered rows stay readable when the column is
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

  // Allocation. Deliberately NOT torn down with the view: the tab owns the shell, and the tab
  // outlives this component every time the dock is closed or another panel is opened. Only a
  // Restart closes what it replaces, which is what `restarting` marks.
  useEffect(() => {
    if (attempt === 0 && attached.current !== undefined) return
    const mine = ++token.current
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
    setFailure(undefined)

    terminalOpen(directory, geometry.current.cols, geometry.current.rows).then(
      (result) => {
        if (!result.ok) {
          if (mine === token.current) settleTerminal(groupKey, tab.tabId, { error: result.message })
          return
        }
        // A superseded attempt's shell is closed here rather than published: nothing would ever
        // reach it, and the tab already points at the allocation that replaced it.
        if (mine !== token.current) { void terminalClose(result.terminalId); return }
        allocated = result.terminalId
        settleTerminal(groupKey, tab.tabId, { terminalId: result.terminalId, shell: result.shell })
      },
      (reason: unknown) => {
        if (mine === token.current) {
          settleTerminal(groupKey, tab.tabId, { error: transportMessage(reason, latest.current) })
        }
      },
    )
    return () => {
      if (!restarting.current || allocated === undefined) return
      restarting.current = false
      void terminalClose(allocated)
    }
  }, [attempt, directory, groupKey, tab.tabId, refit, terminalOpen, terminalClose, settleTerminal, latest])

  const terminalId = tab.terminalId
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
            setFailure(result.message)
            // A handle the Host no longer knows will never be known again — the shell was closed
            // from elsewhere, or the plugin reloaded. Re-arming would poll a dead id forever.
            if (result.code === 'unknown-terminal') { live = false; return }
          }
          timer = window.setTimeout(tick, POLL_MS)
        },
        (reason: unknown) => {
          if (!live) return
          setFailure(transportMessage(reason, latest.current))
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
      if (!result.ok) setFailure(result.message)
    }, (reason: unknown) => { setFailure(transportMessage(reason, latest.current)) })
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

  // A hidden view has a layout box but not the dock's current width; it re-measures when shown.
  useEffect(() => {
    if (!active) return
    refit()
    termRef.current?.focus()
  }, [active, refit])

  const idle = terminalId === undefined || finished
  const error = failure ?? tab.error
  const name = shellName(tab.shell)

  return (
    <div className={cx(css.terminalView, !active && css.terminalViewHidden)} aria-hidden={!active}>
      <div className={css.toolbar}>
        <Badge code title={tab.shell}>{name === '' ? t('terminal.starting') : name}</Badge>
        {finished && <Badge variant="warning">{exit}</Badge>}
        <span className={css.spacer} />
        <Button
          size="icon"
          aria-label={t('terminal.interrupt')}
          title={t('terminal.interrupt')}
          disabled={idle}
          onClick={() => { if (terminalId !== undefined) void terminalInterrupt(terminalId) }}
        >
          <IconStopFill16 />
        </Button>
        <Button
          size="icon"
          aria-label={t('terminal.clear')}
          title={t('terminal.clear')}
          onClick={() => { termRef.current?.clear() }}
        >
          <IconTrashOutline16 />
        </Button>
        <Button
          size="icon"
          aria-label={t('terminal.restart')}
          title={t('terminal.restart')}
          onClick={() => { restarting.current = true; setAttempt(value => value + 1) }}
        >
          <IconRefreshOutline14 />
        </Button>
      </div>

      {lossy && <p className={css.quiet}>{t('terminal.lossy')}</p>}
      {error !== undefined && <Alert tone="destructive" className={css.panelAlert}>{error}</Alert>}
      <div
        ref={hostRef}
        className={css.terminalBox}
        aria-label={t('terminal.inputAria')}
        onClick={() => { termRef.current?.focus() }}
        role="presentation"
      />
    </div>
  )
}

/** What the panel is handed on top of the shared panel props. */
export interface TerminalPanelProps extends PanelProps {
  /** The controller's snapshot hook; the tab strip is rendered from the shared terminal group. */
  useSidebar: SnapshotSelectorHook<SidebarState>
  /** The resolved settings section; absent while neither source has answered. */
  settings: AdvancedSidebarSettings | undefined
}

/**
 * The tab strip and the stack of screens under it.
 * @param props - the target, the translator, the dock's face, and the controller's snapshot hook.
 * @returns the panel body.
 * @see {@link TerminalPanelProps}
 */
export function TerminalPanel({ target, t, face, useSidebar, settings }: TerminalPanelProps) {
  const key = terminalKey(target)
  const group = useSidebar(state => state.terminals[key])
  const tabs = useMemo(() => group?.tabs ?? [], [group])
  const activeId = group?.activeId
  const directory = target.directory
  const { addTerminal, activateTerminal, closeTerminal } = face
  const limit = settings?.maxTerminals ?? DEFAULT_MAX_TERMINALS

  const add = useCallback(() => {
    // A browser-generated id, because the tab exists — and is rendered — before the Host has
    // answered with a handle to name it by.
    addTerminal(key, crypto.randomUUID())
  }, [addTerminal, key])

  // The panel opens with one shell rather than an empty strip: a terminal panel that shows nothing
  // until a button is pressed is one press away from every use of it. Once only — closing the last
  // tab is a decision to have no shell, not a request for a fresh one.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || directory === undefined) return
    started.current = true
    if (tabs.length === 0) add()
  }, [directory, tabs.length, add])

  if (directory === undefined) return <p className={css.quiet}>{t('menu.noDirectory')}</p>

  return (
    <>
      <div className={css.terminalTabs}>
        <Tabs
          aria-label={t('terminal.tabs')}
          tabs={tabs.map((tab, index) => ({
            id: tab.tabId,
            label: t('terminal.tab', { index: index + 1 }),
            title: tab.shell ?? t('terminal.starting'),
          }))}
          value={activeId}
          onValueChange={(id) => { activateTerminal(key, id) }}
          onClose={(id) => { void closeTerminal(key, id) }}
        >
          <Button
            size="icon"
            aria-label={t('terminal.new')}
            title={tabs.length >= limit ? t('terminal.limit', { count: limit }) : t('terminal.new')}
            disabled={tabs.length >= limit}
            onClick={add}
          >
            <IconPlusOutline16 />
          </Button>
        </Tabs>
      </div>
      <div className={css.terminalStack}>
        {tabs.map(tab => (
          <TerminalView
            key={tab.tabId}
            tab={tab}
            groupKey={key}
            directory={directory}
            active={tab.tabId === activeId}
            target={target}
            t={t}
            face={face}
          />
        ))}
      </div>
    </>
  )
}
