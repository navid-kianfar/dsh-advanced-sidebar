/**
 * The Preview panel: one surface with four ways to point it at something.
 *
 * - **Server** — a launch configuration is started on the Host, its port is watched until it
 *   accepts, and the result is framed with its logs beside it. This is the original behaviour and it
 *   is unchanged, including the two controls that are permanent rather than error states: **Logs**,
 *   because a server that failed to start has only its stderr to explain itself, and **Open in a new
 *   window**, because a page can refuse to be framed and a cross-origin frame gives the panel no way
 *   to detect that the load event fired on an error page.
 * - **Files** — any file in the session workspace, rendered by type: an HTML document is framed
 *   live *through this Host's own route*, so it is same-origin and therefore inspectable; Markdown
 *   is rendered as React elements with no raw HTML; images, PDF, audio and video go to the browser's
 *   own elements; anything else is reported with its size and an "open it in the OS" action.
 * - **URL** — any address, with a loopback one routed through this Host's proxy so that it too
 *   becomes same-origin, and a public one framed as-is with the panel saying it is opaque.
 * - **Scratchpad** — an HTML editor whose document is rendered beside it from this Host's route, so
 *   the frame has a real URL and a real origin rather than `srcdoc`'s opaque one.
 *
 * The panel also runs the browser end of the agent channel: a {@link PreviewDriver} polls for
 * commands the model's `ui_preview` tool queued and executes them against whichever frame is
 * mounted. That is the reason the same-origin work exists at all — a cross-origin frame's document
 * is unreachable, so neither the panel nor the model could inspect it.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/PreviewPanel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconLoadingOutline16, IconPlayOutline16, IconRefreshOutline14, IconRightUpOutline16,
  IconStopFill16, MarkdownText, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { frameUrlFor, scratchRoute } from '../../host/preview-content.ts'
import type { PreviewFileInfo, PreviewServerView, PreviewState } from '../../host/types.ts'
import { Alert, Button, Input, Select, Tabs } from '../ui/index.ts'
import { cx } from '../cx.ts'
import { TerminalScreen } from '../terminal-screen.ts'
import { PreviewDriver } from '../preview-driver.ts'
import type { PanelFace, PreviewMode } from '../preview-types.ts'
import { PreviewFileMode, useFileWatch } from './preview-file.tsx'
import { PreviewScratchpadMode, useScratchpad } from './preview-scratchpad.tsx'
import { PreviewUrlMode } from './preview-url.tsx'
import { absoluteIn, formatBytes, transportMessage, useLatest, type PanelProps } from './shared.tsx'
import css from './Panels.module.css'
import own from './Preview.module.css'

/** How often the panel asks for logs and state while a server is starting. */
const FAST_POLL_MS = 400

/** How often it asks once the server is ready and only the log view is watching. */
const SLOW_POLL_MS = 1_500

/** Retained log lines. */
const LOG_LINES = 4_000

/** How often the previewed file's change token is re-read; mirrored by the file mode's own watch. */
const FILE_WATCH_MS = 900

/** The viewport sizes the frame can be pinned to, in the order the picker lists them. */
const DEVICES = [
  { id: 'desktop', width: 0, height: 0 },
  { id: 'tablet', width: 768, height: 1_024 },
  { id: 'mobile', width: 375, height: 812 },
] as const

/** One device preset id. */
type DeviceId = (typeof DEVICES)[number]['id']

/** The modes, in tab order. */
const MODES: readonly PreviewMode[] = ['server', 'file', 'url', 'scratchpad']

/** A snapshot of what the frame is showing, as the driver and the address line report it. */
interface FrameView {
  /** The URL a frame can load, or the empty string when nothing is framed. */
  readonly src: string
  /** Whether the framed document is same-origin with the GUI. */
  readonly inspectable: boolean
  /** The document kind, when the frame is a workspace file. */
  readonly kind: PreviewFileInfo['kind'] | undefined
}

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
 * The four-mode Preview surface, its frame, its logs, and the agent driver.
 * @param props - the target, the translator, and the dock's face.
 * @returns the panel body.
 * @see {@link PanelProps}
 */
export function PreviewPanel({ target, t, face }: PanelProps) {
  const {
    previewList, previewStart, previewStop, previewLogs, previewFileInfo,
    previewPoll, previewResult, previewRelease, openPath,
  } = face
  const latest = useLatest(t)
  const directory = target.directory

  // --- mode and frame state -------------------------------------------------------------------

  const [mode, setMode] = useState<PreviewMode>('server')
  const [error, setError] = useState<string | undefined>(undefined)
  const [frameKey, setFrameKey] = useState(0)
  const [viewport, setViewport] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const [device, setDevice] = useState<DeviceId>('desktop')
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // The URL mode's state, and the address Server mode frames.
  const [url, setUrl] = useState('')
  const [serverAddress, setServerAddress] = useState('')

  // The file mode's state.
  const [filePath, setFilePath] = useState('')
  const [fileInfo, setFileInfo] = useState<PreviewFileInfo | undefined>(undefined)
  const [fileBusy, setFileBusy] = useState(false)

  // Where the same-origin routes are, when this Host has a web server at all.
  const [proxyRoute, setProxyRoute] = useState<string | undefined>(undefined)
  const [fileRoute, setFileRoute] = useState<string | undefined>(undefined)

  // --- the server mode's own state (unchanged behaviour) ---------------------------------------

  const [servers, setServers] = useState<readonly PreviewServerView[] | undefined>(undefined)
  const [launchFile, setLaunchFile] = useState<string | undefined>(undefined)
  const [launchError, setLaunchError] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [showLogs, setShowLogs] = useState(false)
  const [logRevision, setLogRevision] = useState(0)
  const logs = useMemo(() => new TerminalScreen(LOG_LINES), [])
  const logOffset = useRef(0)
  /** The server whose failure already opened the log view; a failed start opens it once, not per poll. */
  const openedOnFailure = useRef<string | undefined>(undefined)
  const logViewRef = useRef<HTMLDivElement>(null)

  // --- the same-origin surface -----------------------------------------------------------------

  useEffect(() => {
    let live = true
    face.describe().then(
      (view) => {
        if (!live) return
        setProxyRoute(view.preview.surface?.available === true ? view.preview.surface.proxyRoute : undefined)
        setFileRoute(view.preview.surface?.available === true ? view.preview.surface.fileRoute : undefined)
      },
      () => {
        // A describe that fails is reported by the panel's own error line when a mode needs it; the
        // surface simply stays unknown, which the modes read as "no same-origin route".
      },
    )
    return () => { live = false }
  }, [face])

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
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(transportMessage(reason, latest.current))
      },
    )
    return () => { controller.abort() }
  }, [directory, generation, previewList, latest])

  const server = servers?.find(entry => entry.name === selected)
  const serverId = server?.serverId
  const state = server?.state ?? 'stopped'
  const serverUrl = server?.url

  // The Server mode's address bar follows the selected server until the operator edits it; a typed
  // address then stays put, because navigating somewhere else is the whole reason it is editable.
  useEffect(() => { setServerAddress(serverUrl ?? '') }, [serverUrl, selected])

  // --- logs and live state --------------------------------------------------------------------

  // A new server means a new stream: the offset and the screen belong to one serverId, and carrying
  // either across would splice two servers' output into one log.
  useEffect(() => {
    logs.clear()
    logOffset.current = 0
    setLogRevision(value => value + 1)
  }, [serverId, logs])

  // A failed server is NOT a reason to keep polling: nothing ever moves a record out of `failed`,
  // so including it here would re-arm the chain forever on a dead process. A start that fails is
  // still covered — it opens the log view, and `showLogs` carries the polling through the transition.
  const watching = serverId !== undefined && (state === 'starting' || showLogs)
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
            // Once per server, not per tick: re-asserting it every poll would make the Logs
            // toggle un-closable on a failed start.
            if (result.server.state === 'failed' && openedOnFailure.current !== serverId) {
              openedOnFailure.current = serverId
              setShowLogs(true)
            }
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
          setError(transportMessage(reason, latest.current))
          timer = window.setTimeout(tick, SLOW_POLL_MS)
        },
      )
    }
    tick()
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [serverId, watching, logs, previewLogs, latest])

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

  // --- the stage's measured box ---------------------------------------------------------------

  // The stage is measured rather than assumed: the dock's width is a setting, and a preset wider
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
  }, [showLogs, mode])

  const pinned = viewport.width > 0 && viewport.height > 0
  const scale = pinned && stage.width > 0 && stage.height > 0
    ? Math.min(1, stage.width / viewport.width, stage.height / viewport.height)
    : 1

  // --- the scratchpad -------------------------------------------------------------------------

  const [scratchSrc, setScratchSrc] = useState('')

  /** Publish one scratchpad document and point the frame at a fresh copy of it. */
  const publishScratch = useCallback((document_: string): void => {
    if (fileRoute === undefined) return
    void fetch(scratchRoute(fileRoute), {
      method: 'POST',
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: document_,
    }).then(
      (response) => {
        if (!response.ok) {
          setError(t('preview.scratch.refused', { status: String(response.status) }))
          return
        }
        setError(undefined)
        // A cache-busting fragment rather than a new URL: the route serves the same document, and
        // only the frame needs to know that the bytes behind it changed.
        setScratchSrc(`${scratchRoute(fileRoute)}#${String(Date.now())}`)
      },
      (reason: unknown) => { setError(transportMessage(reason, latest.current)) },
    )
  }, [fileRoute, latest, t])

  const scratch = useScratchpad(directory, publishScratch)

  // The first publish needs the route, and the route arrives with `describe()` a moment after mount:
  // the scratchpad's own mount effect runs before that, so its call is dropped and this one carries
  // it. Only while the frame is still empty — a document already published must not be posted again
  // by a describe that resolved late.
  useEffect(() => {
    if (modeRef.current !== 'scratchpad') return
    if (scratchSrc !== '' || fileRoute === undefined) return
    publishScratch(scratch.text)
  }, [fileRoute, scratchSrc, scratch.text, publishScratch])

  // --- what the frame is showing ---------------------------------------------------------------

  const proxied = url.trim() === '' || proxyRoute === undefined
    ? { src: url.trim(), sameOrigin: false }
    : frameUrlFor(proxyRoute, url.trim())

  const frame: FrameView = useMemo(() => {
    if (mode === 'server') return { src: serverAddress.trim(), inspectable: false, kind: undefined }
    if (mode === 'url') return { src: proxied.src, inspectable: proxied.sameOrigin, kind: undefined }
    if (mode === 'file') {
      const framed = fileInfo?.kind === 'iframe' && fileInfo.url !== undefined
      return { src: framed ? fileInfo.url ?? '' : '', inspectable: framed, kind: fileInfo?.kind }
    }
    return { src: scratchSrc, inspectable: scratchSrc !== '', kind: undefined }
  }, [mode, serverAddress, proxied, fileInfo, scratchSrc])

  // --- the file mode's watch --------------------------------------------------------------------

  useFileWatch(
    face,
    directory,
    fileInfo?.path,
    useCallback((info: PreviewFileInfo) => { setFileInfo(info) }, []),
    // A moved token REMOUNTS the frame: the file on disk changed, and nothing the previous document
    // cached should survive into the new one.
    useCallback(() => { setFrameKey(value => value + 1) }, []),
  )

  // --- the agent channel -------------------------------------------------------------------------

  const clientId = useMemo(() => `preview-${Math.random().toString(36).slice(2)}-${String(Date.now())}`, [])
  const modeRef = useRef(mode)
  modeRef.current = mode
  const live = useRef({ src: frame.src, inspectable: frame.inspectable, workspace: directory, filePath, viewport })
  live.current = { src: frame.src, inspectable: frame.inspectable, workspace: directory, filePath, viewport }

  /** The file load the driver's `open` performs, without the file mode's own draft state. */
  const loadInto = useCallback((workspace: string, path: string): void => {
    setFileBusy(true)
    previewFileInfo(workspace, absoluteIn(workspace, path)).then(
      (result) => {
        setFileBusy(false)
        if (!result.ok) { setFileInfo(undefined); setError(result.message); return }
        setError(undefined)
        setFileInfo(result)
        setFrameKey(value => value + 1)
      },
      (reason: unknown) => { setFileBusy(false); setError(transportMessage(reason, latest.current)) },
    )
  }, [previewFileInfo, latest])

  const driver = useMemo(
    () => new PreviewDriver(
      { previewPoll, previewResult, previewRelease },
      clientId,
      target.sessionId,
      {
        frame: () => {
          const element = frameRef.current
          if (element === null) return { element: null, document: null, window: null }
          let document_: Document | null = null
          let window_: Window | null = null
          try {
            document_ = element.contentDocument
            window_ = element.contentWindow
          } catch {
            // A cross-origin frame throws on `contentDocument` in some engines and answers null in
            // others; both mean the same thing to a caller, and this is that boundary.
            document_ = null
            window_ = null
          }
          return { element, document: document_, window: window_ }
        },
        control: (message) => {
          if (message.control !== 'open') return
          const open = message.open
          if (open.mode === 'file' && open.filePath !== undefined) {
            setFilePath(open.filePath)
            if (open.workspacePath !== undefined) loadInto(open.workspacePath, open.filePath)
          } else if (open.mode === 'url' && open.url !== undefined) {
            setUrl(open.url)
            // The loopback case becomes a proxied frame, so the agent's next command finds a
            // same-origin document instead of the cross-origin one it typed.
            setFrameKey(value => value + 1)
          }
          setMode(open.mode)
        },
        reload: () => { setFrameKey(value => value + 1) },
        resize: (width, height) => { setViewport({ width, height }) },
      },
    ),
    // The driver is created once per mounted panel on purpose: its identity is the poll loop, and
    // rebuilding it on every state change would restart that loop at render cadence. The callbacks
    // it closes over read their state through `live.current`, so they never go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientId, target.sessionId, previewPoll, previewResult, previewRelease, loadInto],
  )

  useEffect(() => {
    driver.start(() => {
      const current = live.current
      return {
        mounted: current.src !== '',
        mode: modeRef.current,
        filePath: modeRef.current === 'file' ? current.filePath : undefined,
        workspacePath: current.workspace,
        // The URL a bind reports is what the panel is framing, which is what the Host's proxy needs
        // to place a subresource request that carries no target of its own.
        url: current.inspectable ? current.src : undefined,
        inspectable: current.inspectable,
        width: current.viewport.width,
        height: current.viewport.height,
      }
    })
    return () => { driver.stop() }
  }, [driver])

  // Closing the panel drops its queued work on the Host, so a command the model issued a moment ago
  // fails with "the panel closed" rather than waiting out its deadline.
  useEffect(() => () => { void previewRelease(clientId) }, [previewRelease, clientId])

  // --- actions ----------------------------------------------------------------------------------

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
      (reason: unknown) => { setBusy(false); setError(transportMessage(reason, latest.current)) },
    )
  }, [directory, selected, logs, previewStart, latest])

  const stop = useCallback(() => {
    if (serverId === undefined) return
    setBusy(true)
    previewStop(serverId).then(
      (result) => {
        setBusy(false)
        if (!result.ok) { setError(result.message); return }
        setGeneration(value => value + 1)
      },
      (reason: unknown) => { setBusy(false); setError(transportMessage(reason, latest.current)) },
    )
  }, [serverId, previewStop, latest])

  const running = state === 'starting' || state === 'ready'
  const canStart = server?.startable === true && !running && !busy

  /** Show one mode, clearing the error line so a failure from another mode does not follow it. */
  const showMode = (next: PreviewMode): void => {
    setMode(next)
    setError(undefined)
    if (next === 'scratchpad' && scratchSrc === '' && fileRoute !== undefined) publishScratch(scratch.text)
  }

  // --- rendering --------------------------------------------------------------------------------

  const markdown = mode === 'file' && fileInfo?.kind === 'markdown' && fileInfo.url !== undefined
    ? fileInfo.url
    : undefined
  const plainText = mode === 'file' && fileInfo?.kind === 'text' && fileInfo.url !== undefined
    ? fileInfo.url
    : undefined
  // A file this panel draws itself still has a frame behind it: the same-origin route is what the
  // agent reads, so the iframe stays mounted under the rendered pane and `dom`/`eval` keep working.
  const drawnHere = markdown !== undefined || plainText !== undefined

  return (
    <>
      <Tabs
        className={own.modes}
        aria-label={t('preview.modes')}
        value={mode}
        onValueChange={(id) => { showMode(id as PreviewMode) }}
        tabs={MODES.map(entry => ({
          id: entry,
          label: t(`preview.mode.${entry}` as 'preview.mode.server'),
        }))}
      />

      {mode === 'server' && (
        <>
          <div className={css.toolbar}>
            {dotState(state) !== undefined
              ? <StateDot state={dotState(state) ?? 'done'} className={css.taskDot} />
              : <span className={css.taskDot} />}
            <Select
              className={css.previewPicker}
              aria-label={t('preview.server')}
              value={selected}
              placeholder={t('preview.none')}
              disabled={servers === undefined || servers.length === 0}
              options={(servers ?? []).map(entry => ({
                value: entry.name,
                label: entry.name,
                note: entry.origin === 'launch-json' ? 'launch.json' : undefined,
              }))}
              onValueChange={setSelected}
            />
            <span className={css.quietInline}>{t(`preview.state.${state}` as 'preview.state.ready')}</span>
            <span className={css.spacer} />
            {running
              ? (
                <Button
                  size="icon"
                  aria-label={t('preview.stop')}
                  title={t('preview.stop')}
                  disabled={busy}
                  onClick={stop}
                >
                  <IconStopFill16 />
                </Button>
              )
              : (
                <Button
                  size="icon"
                  aria-label={t('preview.start')}
                  title={server?.startable === false ? t('preview.notStartable') : t('preview.start')}
                  disabled={!canStart}
                  onClick={start}
                >
                  {busy ? <IconLoadingOutline16 /> : <IconPlayOutline16 />}
                </Button>
              )}
            <Button
              size="sm"
              active={showLogs}
              aria-label={t('preview.logs')}
              title={t('preview.logs')}
              onClick={() => { setShowLogs(value => !value) }}
            >
              {t('preview.logs')}
            </Button>
          </div>

          <div className={css.toolbar}>
            <Input
              className={css.addressBar}
              code
              spellCheck={false}
              autoComplete="off"
              aria-label={t('preview.address')}
              placeholder={t('preview.address')}
              value={serverAddress}
              onChange={(event) => { setServerAddress(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') setFrameKey(value => value + 1) }}
            />
            <Button
              size="icon"
              aria-label={t('panel.refresh')}
              title={t('panel.refresh')}
              disabled={serverAddress.trim() === ''}
              onClick={() => { setFrameKey(value => value + 1) }}
            >
              <IconRefreshOutline14 />
            </Button>
            <Button
              size="icon"
              aria-label={t('preview.newWindow')}
              title={t('preview.newWindow')}
              disabled={serverAddress.trim() === ''}
              onClick={() => { window.open(serverAddress.trim(), '_blank', 'noopener,noreferrer') }}
            >
              <IconRightUpOutline16 />
            </Button>
            <Button
              size="sm"
              disabled={serverUrl === undefined || proxyRoute === undefined}
              title={t('preview.inspectHint')}
              onClick={() => {
                if (serverUrl === undefined) return
                setUrl(serverUrl)
                showMode('url')
              }}
            >
              {t('preview.inspect')}
            </Button>
          </div>
        </>
      )}

      {mode === 'file' && (
        <PreviewFileMode
          t={t}
          face={face}
          state={{ ...frameState({ mode, directory, proxyRoute, filePath, url, viewport, frame }) }}
          setState={(patch) => {
            if (patch.filePath !== undefined) setFilePath(patch.filePath)
            if (patch.committed === true) setFrameKey(value => value + 1)
          }}
          workspace={directory}
          info={fileInfo}
          busy={fileBusy}
          onInfo={setFileInfo}
          onError={setError}
          onReload={() => { setFrameKey(value => value + 1) }}
        />
      )}

      {mode === 'url' && (
        <PreviewUrlMode
          t={t}
          state={frameState({ mode, directory, proxyRoute, filePath, url, viewport, frame })}
          setState={(patch) => {
            if (patch.url !== undefined) setUrl(patch.url)
            if (patch.committed === true) setFrameKey(value => value + 1)
          }}
          onReload={() => { setFrameKey(value => value + 1) }}
        />
      )}

      {mode === 'scratchpad' && (
        <PreviewScratchpadMode
          t={t}
          state={frameState({ mode, directory, proxyRoute, filePath, url, viewport, frame })}
          setState={() => {
            // The scratchpad owns its text, and the panel owns the frame: nothing in this mode
            // patches the shared state, so a stray patch is ignored rather than applied.
          }}
          scratch={scratch}
          onReload={() => { publishScratch(scratch.text) }}
        />
      )}

      {error !== undefined && <Alert tone="destructive" className={css.panelAlert}>{error}</Alert>}
      {mode === 'server' && launchError !== undefined && <p className={css.quiet}>{launchError}</p>}
      {mode === 'server' && server?.detail !== undefined && state !== 'ready' && <p className={css.quiet}>{server.detail}</p>}
      {mode === 'server' && servers?.length === 0 && (
        <p className={css.quiet}>
          {launchFile === undefined ? t('preview.empty') : t('preview.emptyFile', { file: launchFile })}
        </p>
      )}
      {mode === 'file' && fileInfo !== undefined && (!fileInfo.withinLimit || fileInfo.kind === 'other') && (
        <div className={cx(own.empty, css.previewStageShort)}>
          <p>{fileInfo.withinLimit ? t('preview.file.notPreviewable') : t('preview.file.overLimit')}</p>
          <p>{t('preview.file.facts', {
            name: fileInfo.name,
            kind: t(`preview.kind.${fileInfo.kind}` as 'preview.kind.other'),
            bytes: formatBytes(fileInfo.bytes),
          })}</p>
          <div className={own.emptyActions}>
            <Button size="sm" onClick={() => { void openPath(fileInfo.path) }}>{t('files.open')}</Button>
          </div>
        </div>
      )}

      {mode !== 'file' || fileInfo === undefined || (fileInfo.withinLimit && fileInfo.kind !== 'other') ? (
        <div ref={stageRef} className={cx(css.previewStage, own.stageHost, showLogs && mode === 'server' && css.previewStageShort)}>
          {mode === 'file' && fileInfo?.kind === 'image' && fileInfo.url !== undefined && (
            <img className={own.media} src={fileInfo.url} alt={fileInfo.name} />
          )}
          {mode === 'file' && fileInfo?.kind === 'pdf' && fileInfo.url !== undefined && (
            <iframe className={own.pdfPane} src={fileInfo.url} title={t('preview.frame', { name: fileInfo.name })} />
          )}
          {mode === 'file' && fileInfo?.kind === 'media' && fileInfo.url !== undefined && (
            isAudio(fileInfo.contentType)
              ? <audio className={own.media} src={fileInfo.url} controls />
              : <video className={own.media} src={fileInfo.url} controls />
          )}
          {markdown !== undefined && (
            <div className={own.markdownPane}>
              <RemoteText url={markdown} render={(text) => <MarkdownText text={text} />} t={t} />
            </div>
          )}
          {plainText !== undefined && (
            <div className={own.markdownPane}>
              <RemoteText url={plainText} render={(text) => <pre className={css.previewText}>{text}</pre>} t={t} />
            </div>
          )}
          {frame.src !== ''
            && !(mode === 'file' && (fileInfo?.kind === 'image' || fileInfo?.kind === 'media' || fileInfo?.kind === 'pdf')) && (
            <iframe
              key={frameKey}
              ref={frameRef}
              // Kept MOUNTED and loaded while a Markdown or text pane covers it: the agent's `dom`,
              // `eval` and `console` commands run against this document, and removing it from the
              // tree would leave the model inspecting nothing. `display: none` would also stop the
              // frame loading, which is why it is hidden with visibility instead.
              className={cx(css.previewFrame, drawnHere && own.frameUnder)}
              src={frame.src}
              title={t('preview.frame', { name: frameName(mode, fileInfo, server?.name ?? '') })}
              style={pinned
                ? {
                  width: `${String(viewport.width)}px`,
                  height: `${String(viewport.height)}px`,
                  transform: `scale(${String(scale)})`,
                }
                : undefined}
              // The framed page is someone's own dev server or their own file, not this application:
              // it gets the ordinary same-origin-for-itself sandbox and nothing that would let it
              // reach out. `allow-same-origin` is what makes it inspectable, which is the point.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              referrerPolicy="no-referrer"
            />
          )}
          {frame.src === '' && markdown === undefined && plainText === undefined
            && !(mode === 'file' && fileInfo !== undefined) && (
            <p className={css.quiet}>{mode === 'server' ? t('preview.noUrl') : t('preview.frame.empty')}</p>
          )}
        </div>
      ) : null}

      {mode === 'server' && showLogs && (
        <div ref={logViewRef} className={css.previewLogs}>
          <pre className={css.terminalText}>{logs.snapshot().join('\n')}</pre>
          {logs.snapshot().join('') === '' && <p className={css.quiet}>{t('preview.logs.empty')}</p>}
        </div>
      )}

      {/* The viewport controls live below the frame so every mode has them, including the ones the
          agent drives: `ui_preview resize` writes the same state this picker does. */}
      <div className={cx(css.toolbar, own.viewportBar)}>
        <span className={css.quietInline}>
          {pinned
            ? t('preview.viewport.custom', { width: String(viewport.width), height: String(viewport.height) })
            : t('preview.viewport.fit')}
        </span>
        <span className={css.spacer} />
        <Select
          className={css.previewPicker}
          aria-label={t('preview.device')}
          value={device}
          options={DEVICES.map(entry => ({
            value: entry.id,
            label: t(`preview.device.${entry.id}` as 'preview.device.desktop'),
          }))}
          onValueChange={(next) => {
            const chosen = next as DeviceId
            setDevice(chosen)
            const preset = DEVICES.find(entry => entry.id === chosen)
            setViewport({ width: preset?.width ?? 0, height: preset?.height ?? 0 })
          }}
        />
      </div>
    </>
  )
}

/**
 * Assemble the shared mode state one mode's controls read.
 * @param input - the panel's own state plus the computed frame.
 * @returns the mode state.
 */
function frameState(input: {
  mode: PreviewMode
  directory: string | undefined
  proxyRoute: string | undefined
  filePath: string
  url: string
  viewport: { width: number; height: number }
  frame: FrameView
}): {
  src: string
  url: string
  workspace: string | undefined
  proxyRoute: string | undefined
  inspectable: boolean
  filePath: string
  viewport: { width: number; height: number }
} {
  return {
    src: input.frame.src,
    url: input.mode === 'file' ? input.filePath : input.url,
    workspace: input.directory,
    proxyRoute: input.proxyRoute,
    inspectable: input.frame.inspectable,
    filePath: input.filePath,
    viewport: input.viewport,
  }
}

/**
 * Whether a media MIME type is audio rather than video.
 * @param contentType - the type.
 * @returns true for audio.
 */
function isAudio(contentType: string): boolean {
  return contentType.startsWith('audio/')
}

/**
 * The name a frame's accessible title reports.
 *
 * Read by a screen reader and by nothing else, so it is not translated: the panel's visible labels
 * carry the translated names, and a frame title is an implementation detail of the element.
 * @param mode - the current mode.
 * @param info - the file's description, when the mode is `file`.
 * @param server - the selected server's name, when the mode is `server`.
 * @returns the name.
 */
function frameName(mode: PreviewMode, info: PreviewFileInfo | undefined, server: string): string {
  if (mode === 'file') return info?.name ?? 'file'
  if (mode === 'server') return server
  if (mode === 'scratchpad') return 'scratchpad'
  return 'URL'
}

/**
 * Fetch a text document from this Host's own route and render it.
 *
 * The bytes come over the same-origin route rather than through a Remote endpoint because that route
 * is already bounded, typed, and uncached for exactly this document — and because a Markdown file is
 * rendered from text, so the panel must hold it rather than frame it.
 * @param props.url - the same-origin file URL.
 * @param props.render - how to render the loaded text.
 * @param props.t - the translator, for the failure line.
 * @returns the rendered document, or the reason it could not be read.
 */
function RemoteText({ url, render, t }: {
  url: string
  render: (text: string) => ReactNode
  t: PanelProps['t']
}) {
  const [text, setText] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    setText(undefined)
    setError(undefined)
    fetch(url).then(
      (response) => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${String(response.status)}`))),
      (reason: unknown) => Promise.reject(reason instanceof Error ? reason : new Error(String(reason))),
    ).then(
      (body) => { if (live) setText(body) },
      (reason: unknown) => {
        if (live) setError(t('preview.file.readFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
      },
    )
    return () => { live = false }
  }, [url, t])
  if (error !== undefined) return <Alert tone="destructive">{error}</Alert>
  if (text === undefined) return <p className={css.quiet}>{t('panel.loading')}</p>
  return render(text)
}
