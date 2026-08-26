/**
 * The Preview panel: run the thing you are building and look at it without leaving the session.
 *
 * A launch configuration is started on the Host, its port is watched until it accepts, and the
 * result is rendered in a frame beside the conversation. The frame is a plain `<iframe>` pointed at
 * a loopback URL, which is what makes this work for any dev server rather than for a list of
 * blessed ones.
 *
 * Two things a person needs are therefore always present, not hidden behind a state:
 *
 * - **Logs.** A server that failed to start has nothing to show in the frame, and its stderr is the
 *   only place the reason exists. The log view is one toggle away at every state, and opens itself
 *   when a start fails.
 * - **Open in a new window.** A page can refuse to be framed (`X-Frame-Options`,
 *   `frame-ancestors`), and cross-origin framing gives the panel no way to detect that — the load
 *   event fires either way. So the escape hatch is a permanent control rather than an error
 *   recovery, and the panel says so instead of pretending a blank frame is a loading one.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/PreviewPanel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconLoadingOutline16, IconPlayOutline16, IconRefreshOutline14, IconRightUpOutline16,
  IconStopFill16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PreviewServerView, PreviewState } from '../../host/types.ts'
import type { Translate } from '../contract.ts'
import { cx } from '../cx.ts'
import { TerminalScreen } from '../terminal-screen.ts'
import { transportMessage, type PanelProps } from './shared.ts'
import css from './Panels.module.css'

/** How often the panel asks for logs and state while a server is starting. */
const FAST_POLL_MS = 400

/** How often it asks once the server is ready and only the log view is watching. */
const SLOW_POLL_MS = 1_500

/** Retained log lines. */
const LOG_LINES = 4_000

/** The viewport sizes the frame can be pinned to, in the order the picker lists them. */
const DEVICES = [
  { id: 'desktop', width: 0, height: 0 },
  { id: 'tablet', width: 768, height: 1_024 },
  { id: 'mobile', width: 375, height: 812 },
] as const

/** One device preset id. */
type DeviceId = (typeof DEVICES)[number]['id']

/**
 * Status marker for one server state.
 *
 * `stopped` has no marker of its own: the dot set carries no neutral member, and a `warning` dot on
 * a server nobody started would read as something being wrong.
 * @param state - the server's lifecycle state.
 * @returns the dot state, or undefined while nothing is running.
 */
function dotState(state: PreviewState): StateDotState | undefined {
  switch (state) {
    case 'ready': return 'done'
    case 'starting': return 'ongoing'
    case 'failed': return 'error'
    case 'exited': return 'warning'
    default: return undefined
  }
}

/**
 * The server picker, the frame, and the log view.
 * @param props - the target, the translator, and the drawer's face.
 * @returns the panel body.
 * @see {@link PanelProps}
 */
export function PreviewPanel({ target, t, face }: PanelProps) {
  const { previewList, previewStart, previewStop, previewLogs } = face
  const directory = target.directory
  const [servers, setServers] = useState<readonly PreviewServerView[] | undefined>(undefined)
  const [launchFile, setLaunchFile] = useState<string | undefined>(undefined)
  const [launchError, setLaunchError] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [address, setAddress] = useState('')
  const [frameKey, setFrameKey] = useState(0)
  const [device, setDevice] = useState<DeviceId>('desktop')
  const [showLogs, setShowLogs] = useState(false)
  const [logRevision, setLogRevision] = useState(0)
  const logs = useMemo(() => new TerminalScreen(LOG_LINES), [])
  const logOffset = useRef(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const logViewRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })

  // --- the configuration list -----------------------------------------------------------------

  useEffect(() => {
    if (directory === undefined) return
    const controller = new AbortController()
    setError(undefined)
    previewList(directory, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        if (!result.ok) { setError(result.message); return }
        setServers(result.servers)
        setLaunchFile(result.launchFile)
        setLaunchError(result.launchFileError)
        // The first configuration is selected on arrival so the panel opens on something rather
        // than on an empty picker the operator has to notice.
        setSelected(current => current ?? result.servers[0]?.name)
      },
      (reason: unknown) => { if (!controller.signal.aborted) setError(transportMessage(reason, t)) },
    )
    return () => { controller.abort() }
  }, [directory, generation, previewList, t])

  const server = servers?.find(entry => entry.name === selected)
  const serverId = server?.serverId
  const state = server?.state ?? 'stopped'

  // The address bar follows the selected server until the operator edits it; a typed address then
  // stays put, because navigating somewhere else is the whole reason the field is editable.
  const serverUrl = server?.url
  useEffect(() => { setAddress(serverUrl ?? '') }, [serverUrl, selected])

  // --- logs and live state --------------------------------------------------------------------

  // A new server means a new stream: the offset and the screen belong to one serverId, and carrying
  // either across would splice two servers' output into one log.
  useEffect(() => {
    logs.clear()
    logOffset.current = 0
    setLogRevision(value => value + 1)
  }, [serverId, logs])

  const watching = serverId !== undefined && (state === 'starting' || showLogs || state === 'failed')
  useEffect(() => {
    if (serverId === undefined || !watching) return
    let live = true
    let timer = 0
    const tick = (): void => {
      previewLogs(serverId, logOffset.current).then(
        (result) => {
          if (!live) return
          if (result.ok) {
            if (result.text !== '') {
              logs.write(result.text)
              setLogRevision(value => value + 1)
            }
            logOffset.current = result.nextOffset
            // The state rides the same response, so a start that succeeds or fails is noticed
            // without a second endpoint and without a list refresh.
            setServers(current => current?.map(entry =>
              entry.name === result.server.name ? result.server : entry))
            if (result.server.state === 'failed') setShowLogs(true)
          } else if (result.code === 'unknown-server') {
            // The server was stopped from elsewhere; stop polling for it rather than looping on a
            // handle the Host has forgotten.
            live = false
            setGeneration(value => value + 1)
            return
          } else {
            setError(result.message)
          }
          const cadence = result.ok && result.server.state === 'starting' ? FAST_POLL_MS : SLOW_POLL_MS
          timer = window.setTimeout(tick, cadence)
        },
        (reason: unknown) => {
          if (!live) return
          setError(transportMessage(reason, t))
          timer = window.setTimeout(tick, SLOW_POLL_MS)
        },
      )
    }
    tick()
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [serverId, watching, logs, previewLogs, t])

  useEffect(() => {
    const view = logViewRef.current
    if (view === null) return
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40
    if (atBottom) view.scrollTop = view.scrollHeight
  }, [logRevision])

  // The frame reloads itself when a starting server becomes ready: the first load would have hit a
  // port that was not listening yet and cached a connection error.
  const readyMark = state === 'ready' ? serverId ?? server?.name : undefined
  useEffect(() => {
    if (readyMark !== undefined) setFrameKey(value => value + 1)
  }, [readyMark])

  // --- device presets -------------------------------------------------------------------------

  // The stage is measured rather than assumed: the drawer's width is a setting, and a preset wider
  // than the stage has to be scaled down instead of clipped.
  useEffect(() => {
    const element = stageRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setStage({ width: element.clientWidth, height: element.clientHeight })
    })
    observer.observe(element)
    setStage({ width: element.clientWidth, height: element.clientHeight })
    return () => { observer.disconnect() }
  }, [showLogs])

  const preset = DEVICES.find(entry => entry.id === device) ?? DEVICES[0]
  const framed = preset.width > 0 && preset.height > 0
  const scale = framed && stage.width > 0 && stage.height > 0
    ? Math.min(1, stage.width / preset.width, stage.height / preset.height)
    : 1

  // --- actions --------------------------------------------------------------------------------

  const start = useCallback(() => {
    if (directory === undefined || selected === undefined) return
    setBusy(true)
    setError(undefined)
    logs.clear()
    logOffset.current = 0
    previewStart(directory, selected).then(
      (result) => {
        setBusy(false)
        if (!result.ok) { setError(result.message); setShowLogs(true); return }
        setServers(current => current?.map(entry =>
          entry.name === result.server.name ? result.server : entry))
      },
      (reason: unknown) => { setBusy(false); setError(transportMessage(reason, t)) },
    )
  }, [directory, selected, logs, previewStart, t])

  const stop = useCallback(() => {
    if (serverId === undefined) return
    setBusy(true)
    previewStop(serverId).then(
      (result) => {
        setBusy(false)
        if (!result.ok) { setError(result.message); return }
        setGeneration(value => value + 1)
      },
      (reason: unknown) => { setBusy(false); setError(transportMessage(reason, t)) },
    )
  }, [serverId, previewStop, t])

  const running = state === 'starting' || state === 'ready'
  const canStart = server?.startable === true && !running && !busy
  const src = address.trim()

  return (
    <>
      <div className={css.toolbar}>
        {dotState(state) !== undefined
          ? <StateDot state={dotState(state) ?? 'done'} className={css.taskDot} />
          : <span className={css.taskDot} />}
        <select
          className={css.previewPicker}
          aria-label={t('preview.server')}
          value={selected ?? ''}
          disabled={servers === undefined || servers.length === 0}
          onChange={(event) => { setSelected(event.target.value) }}
        >
          {(servers ?? []).map(entry => (
            <option key={entry.name} value={entry.name}>
              {entry.origin === 'launch-json' ? `${entry.name} · launch.json` : entry.name}
            </option>
          ))}
          {servers?.length === 0 && <option value="">{t('preview.none')}</option>}
        </select>
        <span className={css.quietInline}>{t(`preview.state.${state}` as 'preview.state.ready')}</span>
        <span className={css.spacer} />
        {running
          ? (
            <button
              type="button"
              className={css.toolButton}
              aria-label={t('preview.stop')}
              title={t('preview.stop')}
              disabled={busy}
              onClick={stop}
            >
              <IconStopFill16 />
            </button>
          )
          : (
            <button
              type="button"
              className={css.toolButton}
              aria-label={t('preview.start')}
              title={server?.startable === false ? t('preview.notStartable') : t('preview.start')}
              disabled={!canStart}
              onClick={start}
            >
              {busy ? <IconLoadingOutline16 /> : <IconPlayOutline16 />}
            </button>
          )}
        <button
          type="button"
          className={cx(css.toolButton, showLogs && css.toolButtonOn)}
          aria-label={t('preview.logs')}
          aria-pressed={showLogs}
          title={t('preview.logs')}
          onClick={() => { setShowLogs(value => !value) }}
        >
          <span className={css.toolText}>{t('preview.logs')}</span>
        </button>
      </div>

      <div className={css.toolbar}>
        <input
          className={css.addressBar}
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={t('preview.address')}
          placeholder={t('preview.address')}
          value={address}
          onChange={(event) => { setAddress(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') setFrameKey(value => value + 1) }}
        />
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('panel.refresh')}
          title={t('panel.refresh')}
          disabled={src === ''}
          onClick={() => { setFrameKey(value => value + 1) }}
        >
          <IconRefreshOutline14 />
        </button>
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('preview.newWindow')}
          title={t('preview.newWindow')}
          disabled={src === ''}
          onClick={() => { window.open(src, '_blank', 'noopener,noreferrer') }}
        >
          <IconRightUpOutline16 />
        </button>
        <select
          className={css.previewPicker}
          aria-label={t('preview.device')}
          value={device}
          onChange={(event) => { setDevice(event.target.value as DeviceId) }}
        >
          {DEVICES.map(entry => (
            <option key={entry.id} value={entry.id}>
              {t(`preview.device.${entry.id}` as 'preview.device.desktop')}
            </option>
          ))}
        </select>
      </div>

      {error !== undefined && <p className={css.error}>{error}</p>}
      {launchError !== undefined && <p className={css.quiet}>{launchError}</p>}
      {server?.detail !== undefined && state !== 'ready' && <p className={css.quiet}>{server.detail}</p>}
      {servers?.length === 0 && (
        <p className={css.quiet}>
          {launchFile === undefined ? t('preview.empty') : t('preview.emptyFile', { file: launchFile })}
        </p>
      )}

      <div ref={stageRef} className={cx(css.previewStage, showLogs && css.previewStageShort)}>
        {src === ''
          ? <p className={css.quiet}>{t('preview.noUrl')}</p>
          : (
            <iframe
              key={frameKey}
              className={css.previewFrame}
              src={src}
              title={t('preview.frame', { name: server?.name ?? '' })}
              style={framed
                ? {
                  width: `${String(preset.width)}px`,
                  height: `${String(preset.height)}px`,
                  transform: `scale(${String(scale)})`,
                }
                : undefined}
              // The framed page is someone's own dev server, not this application: it gets the
              // ordinary same-origin-for-itself sandbox and nothing that would let it reach out.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              referrerPolicy="no-referrer"
            />
          )}
      </div>

      {showLogs && (
        <div ref={logViewRef} className={css.previewLogs}>
          <pre className={css.terminalText}>{logs.snapshot().join('\n')}</pre>
          {logs.snapshot().join('') === '' && <p className={css.quiet}>{t('preview.logs.empty')}</p>}
        </div>
      )}
    </>
  )
}
