/**
 * The dock: a resizable column on the right of the frame holding whichever panel is open, plus the
 * notice line and the Delete confirmation.
 *
 * It was a floating card. It is now a real column — it reserves its own width on the app frame, so
 * the conversation shrinks beside it instead of disappearing under it, and it carries a drag handle
 * on its left edge like the frame's own two columns. The reservation is a padding on the frame
 * element and a matching shift of the frame's details handle, both keyed on one custom property
 * this component sets: `shell.overlay` is the only additive frame-wide seat a plugin has, and its
 * layer is drawn above the columns rather than between them.
 *
 * Below a frame narrow enough that pushing would leave no conversation, the dock floats over it
 * instead. That is the same concession every editor makes at that width, and it is derived from the
 * frame's measured box rather than from a media query, because the frame is not the window.
 * @module @achasoft/dsh-advanced-sidebar/client/PanelHost
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelHostProps } from './contract.ts'
import { cx } from './cx.ts'
import { ChangesPanel } from './panels/ChangesPanel.tsx'
import { FilesPanel } from './panels/FilesPanel.tsx'
import { PathText } from './panels/shared.tsx'
import { useCapabilityView } from './use-capability.ts'
import { PreviewPanel } from './panels/PreviewPanel.tsx'
import { TasksPanel } from './panels/TasksPanel.tsx'
import { TerminalPanel } from './panels/TerminalPanel.tsx'
import { Alert, AlertDialog, Button } from './ui/index.ts'
import css from './PanelHost.module.css'

/** How long a notice stays before it withdraws itself. */
const NOTICE_MS = 6_000

/** Smallest dock the layout keeps usable; below it the panels have no room for two columns. */
const MIN_WIDTH = 280

/** Largest dock a drag can reach, so the column cannot swallow the conversation on a wide screen. */
const MAX_WIDTH = 960

/** Conversation width the dock refuses to push below; past it the dock floats instead. */
const MIN_CENTER = 400

/** Pixels one arrow key moves the drag handle, matching the step a keyboard resize is expected to take. */
const KEY_STEP = 16

/** The custom property the frame's reserved width is read from; also declared in the stylesheet. */
const RESERVED = '--dsh-advanced-dock-reserved'

/** The marker the frame carries while a dock is open, which is what arms the reservation rules. */
const DOCK_ATTRIBUTE = 'data-dsh-advanced-dock'

/**
 * The app frame that owns one dock element.
 *
 * Found through the overlay layer's own `data-shell-overlay` marker rather than by class: the
 * frame's classes are CSS-Modules hashes of another package, and the marker is the seam AppFrame
 * publishes.
 * @param dock - the dock element.
 * @returns the frame element, or null before the dock is attached.
 */
function frameOf(dock: HTMLElement | null): HTMLElement | null {
  const layer = dock?.closest('[data-shell-overlay]')
  return layer?.parentElement ?? null
}

/**
 * The dock, the notice, and the confirmation dialog.
 * @param props - the standard kit plus this plugin's face.
 * @returns the overlay tree, or null while nothing is open.
 * @see {@link PanelHostProps}
 */
export function PanelHost(props: PanelHostProps) {
  const { t, useSidebar, useSettings, useSessions } = props
  const panel = useSidebar(state => state.panel)
  const confirm = useSidebar(state => state.confirm)
  const notice = useSidebar(state => state.notice)
  const storedWidth = useSidebar(state => state.dockWidth)
  const bound = useSettings(snapshot => snapshot.value)
  const writable = useSettings(snapshot => snapshot.writable)
  const { close, dismissNotice, dismissDelete, forgetSession, setDockWidth, setPanelWidth } = props
  // Probed only while the dock is open; the fallback matters for the same reason as in the seat.
  const { view } = useCapabilityView(props.describe, panel.panel !== undefined)
  const settings = bound ?? view?.settings

  const dockRef = useRef<HTMLElement | null>(null)
  /**
   * What the dock may take from the frame: its width less the sidebar's, because the sidebar never
   * concedes — the frame's own solver holds it at its preference and lets the centre absorb every
   * squeeze, so a ceiling measured from the frame alone spends the sidebar's width twice and leaves
   * the conversation a sliver.
   */
  const [reservable, setReservable] = useState(0)
  const open = panel.panel !== undefined && panel.target !== undefined

  // The frame's own box, not the window's: the Web Client can be embedded, and the concession the
  // dock makes is about the space beside it rather than about the screen. Measured before paint, so
  // the first frame is already at the settled width instead of opening at the minimum and jumping.
  useLayoutEffect(() => {
    if (!open) return
    const frame = frameOf(dockRef.current)
    if (frame === null) return
    // The sidebar is the frame's first column; its rendered width is the one the frame's own solver
    // has already committed to, collapsed rail included.
    const sidebar = frame.firstElementChild
    const measure = (): void => {
      const width = frame.getBoundingClientRect().width
      setReservable(width - (sidebar?.getBoundingClientRect().width ?? 0))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    if (sidebar !== null) observer.observe(sidebar)
    return () => { observer.disconnect() }
  }, [open])

  const preferred = storedWidth ?? settings?.panelWidth ?? MIN_WIDTH
  const ceiling = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, reservable - MIN_CENTER))
  const width = Math.max(MIN_WIDTH, Math.min(preferred, ceiling))
  // What is left of the frame cannot hold both, so the dock stops reserving and floats over the
  // column it would otherwise have squeezed to nothing.
  const floating = reservable > 0 && reservable < MIN_WIDTH + MIN_CENTER

  /** Write one width to the dock and to the frame's reservation, without going through React. */
  const applyWidth = useCallback((next: number, reserve: boolean): void => {
    const dock = dockRef.current
    if (dock === null) return
    dock.style.width = `${String(next)}px`
    const frame = frameOf(dock)
    if (frame === null) return
    if (reserve) frame.style.setProperty(RESERVED, `${String(next)}px`)
    else frame.style.removeProperty(RESERVED)
  }, [])

  // The marker and the reservation are put on the frame while a dock is open and taken off with it,
  // so an unloaded plugin leaves the frame exactly as it found it.
  useLayoutEffect(() => {
    const dock = dockRef.current
    const frame = frameOf(dock)
    if (frame === null || dock === null) return
    frame.setAttribute(DOCK_ATTRIBUTE, '')
    return () => {
      frame.removeAttribute(DOCK_ATTRIBUTE)
      frame.style.removeProperty(RESERVED)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    applyWidth(width, !floating)
  }, [open, width, floating, applyWidth])

  const dragRef = useRef({ latest: 0, frame: 0 })
  const [dragging, setDragging] = useState(false)

  /** Clamp one requested width into the range the current frame allows. */
  const clampWidth = useCallback(
    (next: number): number => Math.max(MIN_WIDTH, Math.min(Math.round(next), ceiling)),
    [ceiling],
  )

  /** Store one width, in the controller always and in the settings section when it is writable. */
  const commit = useCallback((next: number): void => {
    setDockWidth(next)
    // A remote Web Client has no settings document to write to; the controller's copy is what keeps
    // the drag in effect there for the rest of the browser session.
    if (writable) void setPanelWidth(next)
  }, [setDockWidth, setPanelWidth, writable])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { latest: width, frame: 0 }
    setDragging(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const dock = dockRef.current
    if (dock === null) return
    // Measured against the dock's own right edge rather than accumulated from a drag origin: the
    // clamp at either end would otherwise leave the pointer and the edge separated by whatever the
    // clamp swallowed.
    const next = clampWidth(dock.getBoundingClientRect().right - event.clientX)
    dragRef.current.latest = next
    // Written straight to the DOM at pointer cadence. Committing to React here would re-render the
    // open panel — a diff list, or a terminal emulator — on every pointer move.
    if (dragRef.current.frame === 0) {
      dragRef.current.frame = requestAnimationFrame(() => {
        dragRef.current.frame = 0
        applyWidth(dragRef.current.latest, !floating)
      })
    }
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (dragRef.current.frame !== 0) {
      cancelAnimationFrame(dragRef.current.frame)
      dragRef.current.frame = 0
    }
    applyWidth(dragRef.current.latest, !floating)
    setDragging(false)
    commit(dragRef.current.latest)
  }

  // A session that leaves the list takes its panel and its pending confirmation with it: both act
  // on an id the Host would now refuse, and leaving them open invites a click that cannot work.
  const panelId = panel.target?.sessionId
  const confirmId = confirm?.target.sessionId
  // Checked per id, not merged: the dock and a pending Delete can name DIFFERENT sessions, and one
  // `??` would report the dock's session as live and leave a confirmation open on a row the Host
  // has already forgotten.
  const panelGone = useSessions(state =>
    panelId !== undefined && state.byId[panelId as keyof typeof state.byId] === undefined)
  const confirmGone = useSessions(state =>
    confirmId !== undefined && state.byId[confirmId as keyof typeof state.byId] === undefined)
  useEffect(() => {
    if (panelGone && panelId !== undefined) forgetSession(panelId)
    if (confirmGone && confirmId !== undefined) forgetSession(confirmId)
  }, [panelGone, confirmGone, panelId, confirmId, forgetSession])

  // Escape closes the dock, but only when the confirmation is not up: the dialog owns Escape while
  // it is open, and closing both at once would be one gesture undoing two decisions.
  useEffect(() => {
    if (!open || confirm !== undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A menu, a select, or a picker owns Escape while it is open. Its own listener cannot stop
      // this one — both sit on the document, and this one was added first — so the dock defers by
      // asking whether any of the kit's floating surfaces is currently mounted.
      if (document.querySelector('[data-dsh-layer]') !== null) return
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, confirm, close])

  const noticeId = notice?.id
  useEffect(() => {
    if (noticeId === undefined) return
    const timer = window.setTimeout(() => { dismissNotice(noticeId) }, NOTICE_MS)
    return () => { window.clearTimeout(timer) }
  }, [noticeId, dismissNotice])

  const target = panel.target

  return (
    <>
      {open && panel.panel !== undefined && target !== undefined && (
        <aside
          ref={dockRef}
          className={cx(css.dock, floating && css.dockFloating, dragging && css.dockDragging)}
          style={{ width }}
          aria-label={t(`${panel.panel}.title` as 'changes.title')}
        >
          <div
            className={css.resize}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('panel.resize')}
            aria-valuenow={width}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={ceiling}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onKeyDown={(event) => {
              const delta = event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0
              if (delta === 0) return
              event.preventDefault()
              commit(clampWidth(width + delta))
            }}
            onDoubleClick={() => { commit(clampWidth(settings?.panelWidth ?? MIN_WIDTH)) }}
          />
          <header className={css.head}>
            <div className={css.headText}>
              <h2 className={css.title}>{t(`${panel.panel}.title` as 'changes.title')}</h2>
              {target.directory === undefined
                ? <p className={css.subtitle}>{t('panel.session', { name: target.title })}</p>
                : <PathText value={target.directory} className={css.subtitle} />}
            </div>
            <Button size="icon" aria-label={t('panel.close')} onClick={close}>
              <IconCloseOutline16 />
            </Button>
          </header>
          {/* Keyed on what the panel acts on, so switching sessions REMOUNTS it. Without this,
              React reuses the instance and an expanded diff, a scrolled listing, or a selected
              preview row survives into a different repository and describes the wrong one. */}
          <div className={css.body} key={`${panel.panel}:${target.sessionId}:${target.directory ?? ''}`}>
            {panel.panel === 'changes' && <ChangesPanel target={target} t={t} face={props} />}
            {panel.panel === 'terminal' && (
              <TerminalPanel target={target} t={t} face={props} useSidebar={useSidebar} settings={settings} />
            )}
            {panel.panel === 'files' && <FilesPanel target={target} t={t} face={props} />}
            {panel.panel === 'preview' && <PreviewPanel target={target} t={t} face={props} />}
            {panel.panel === 'tasks' && (
              <TasksPanel target={target} t={t} face={props} useSessions={useSessions} settings={settings} />
            )}
          </div>
        </aside>
      )}

      {notice !== undefined && (
        <div className={css.noticeSlot}>
          <Alert
            tone={notice.tone === 'error' ? 'destructive' : 'default'}
            action={(
              <Button size="icon" aria-label={t('notice.dismiss')} onClick={() => { dismissNotice(notice.id) }}>
                <IconCloseOutline16 />
              </Button>
            )}
          >
            {notice.text}
          </Alert>
        </div>
      )}

      <AlertDialog
        open={confirm !== undefined}
        onClose={dismissDelete}
        onConfirm={() => { if (confirm !== undefined) void props.commitDelete(confirm.target) }}
        title={t('delete.title')}
        {...confirm === undefined
          ? {}
          : { description: t(confirm.purges ? 'delete.body.purge' : 'delete.body.archive', { name: confirm.target.title }) }}
        confirmLabel={t('delete.confirm')}
        cancelLabel={t('delete.cancel')}
        destructive
        busy={confirm?.busy === true}
      />
    </>
  )
}
