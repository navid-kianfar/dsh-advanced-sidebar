/**
 * The advanced-operations menu itself, in the session header.
 *
 * Entries are built from two independent facts: what the settings section switched on, and what the
 * Host reported it can serve. A switched-off entry is absent; an entry the Host cannot serve is
 * present but disabled and carries the reason beside its label, because a person who configured an
 * editor and sees no row cannot tell a typo from a feature that does not exist.
 * @module @achasoft/dsh-advanced-sidebar/client/ActionMenu
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconArchiveOutline20, IconDownloadOutline16, IconEllipsisOutline16, IconFolderOpenOutline16,
  IconQueueOutline14, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AdvancedSidebarSettings, AdvancedSidebarView } from '../host/types.ts'
import type { MenuInjected, Translate } from './contract.ts'
import type { OperationTarget, PanelKind } from './controller.ts'
import { ChangesGlyph, ExternalGlyph, PreviewGlyph, TerminalGlyph } from './Glyphs.tsx'
import { Button, DropdownMenu, type MenuNode } from './ui/index.ts'
import { cx } from './cx.ts'
import css from './ActionMenu.module.css'

/** Submenu ids are namespaced, because the menu reports every selection through one flat handler. */
const OPEN_IN_PREFIX = 'open-in:'

/** The Open in entry for a second browser window; not a Host target, so it has no configured id. */
const NEW_WINDOW_ID = `${OPEN_IN_PREFIX}new-window`

/** The menu id of Download session log; not a panel, so it has no {@link PanelKind}. */
const DOWNLOAD_LOG_ID = 'download-log'

/** What the menu needs to know about the harness's session-log export for this session. */
export interface LogDownloadRow {
  /** Whether this plugin is the download surface; false leaves the entry out entirely. */
  active: boolean
  /** Whether this session's export is in flight, which disables the entry as the harness's did. */
  busy: boolean
}

/** Everything the menu renders from, plus the callbacks it fires. */
export interface ActionMenuProps {
  /** The session and directory every entry acts on; absent disables everything but the trigger. */
  target: OperationTarget | undefined
  /** The resolved settings section; absent while the scope is still loading. */
  settings: AdvancedSidebarSettings | undefined
  /** The Host capability view; absent until the first probe answers. */
  view: AdvancedSidebarView | undefined
  /** The namespace translator. */
  t: Translate
  /** Business callbacks, minus the reactive sources the seat binds itself. */
  actions: Pick<MenuInjected, 'openPanel' | 'openIn' | 'openWindow' | 'archive' | 'requestDelete' | 'downloadLog'>
  /** Ask the Host for a fresh capability view; called each time the menu opens. */
  refresh: () => void
  /** Which panel the dock is showing, so the open entry reads as the current one. */
  openPanel: PanelKind | undefined
  /** The session-log export entry's state. */
  logDownload: LogDownloadRow
  /**
   * Offer Download session log and nothing else. Set when the settings section switched the menu
   * out of the header: this plugin still shadows the harness's own download button, so it stands in
   * for exactly that button rather than taking the verb away with the menu.
   */
  logsOnly: boolean
}

/**
 * The trigger plus its menu.
 * @param props - the target, settings, capability view, translator, and callbacks.
 * @returns the menu element, or null when the settings section leaves it with no entries.
 * @see {@link ActionMenuProps}
 */
export function ActionMenu(props: ActionMenuProps) {
  const { target, settings, view, t, actions, refresh, openPanel, logDownload, logsOnly } = props
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // A capability probe per open, not per mount: git can be installed, an editor can appear, and a
  // menu that answered once at boot would keep reporting the state of that moment forever.
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  // Only a target that DISAPPEARS closes the menu — the session was archived from elsewhere while
  // it was open, so every entry now acts on nothing. Opening with no session is fine and stays
  // open: each entry is disabled with "Open a session first" beside it, which is a better answer
  // than a button that visibly does nothing.
  const had = useRef(false)
  useEffect(() => {
    if (target !== undefined) { had.current = true; return }
    if (open && had.current) setOpen(false)
    had.current = false
  }, [open, target])

  if (settings === undefined) return null
  // Every settings switch reads through this, so the logs-only trigger carries no other entry.
  const shown = (flag: boolean): boolean => flag && !logsOnly

  const directory = target?.directory
  const unavailable = (state: { available: boolean; reason?: string } | undefined): string | undefined => {
    if (target === undefined) return t('menu.noSession')
    if (directory === undefined) return t('menu.noDirectory')
    if (state === undefined) return undefined
    return state.available ? undefined : (state.reason ?? t('settings.unavailable'))
  }

  const items: MenuNode[] = []
  const panelRow = (
    id: PanelKind, key: Parameters<Translate>[0], icon: ReactNode,
    state: { available: boolean; reason?: string } | undefined,
  ): void => {
    const note = unavailable(state)
    items.push({
      kind: 'item',
      id,
      label: t(key),
      note,
      icon,
      disabled: note !== undefined,
      checked: openPanel === id,
    })
  }

  if (shown(settings.showChanges)) panelRow('changes', 'menu.changes', <ChangesGlyph size={16} />, view?.git)
  if (shown(settings.showTerminal)) panelRow('terminal', 'menu.terminal', <TerminalGlyph size={16} />, view?.terminal)
  if (shown(settings.showFiles)) panelRow('files', 'menu.files', <IconFolderOpenOutline16 />, view?.files)
  if (shown(settings.showPreview)) panelRow('preview', 'menu.preview', <PreviewGlyph size={16} />, view?.preview)
  if (shown(settings.showTasks)) {
    // The tasks panel needs a session, not a directory: a background task belongs to a session
    // whether or not that session ever had a working tree.
    const note = target === undefined
      ? t('menu.noSession')
      : (view?.tasks.available === false ? (view.tasks.reason ?? t('settings.unavailable')) : undefined)
    items.push({
      kind: 'item',
      id: 'tasks',
      label: t('menu.tasks'),
      note,
      icon: <IconQueueOutline14 size={16} />,
      disabled: note !== undefined,
      checked: openPanel === 'tasks',
    })
  }

  if (shown(settings.showOpenIn)) {
    const submenu: MenuNode[] = [{ kind: 'item', id: NEW_WINDOW_ID, label: t('menu.openIn.newWindow') }]
    for (const entry of view?.openIn ?? []) {
      submenu.push({
        kind: 'item',
        id: `${OPEN_IN_PREFIX}${entry.id}`,
        label: entry.label,
        note: entry.available ? undefined : t('settings.editors.missing'),
        disabled: !entry.available || directory === undefined,
      })
    }
    if (items.length > 0) items.push({ kind: 'separator', id: 'sep-open-in' })
    items.push({
      kind: 'sub',
      id: 'open-in',
      label: t('menu.openIn'),
      icon: <ExternalGlyph size={16} />,
      items: submenu,
    })
  }

  const sessionEntries: MenuNode[] = []
  // First in the session group: it only reads the session, where Archive and Delete change it. Not
  // gated on a directory, because the export is of the session's log, not of its working tree.
  if (logDownload.active) {
    const note = target === undefined
      ? t('menu.noSession')
      : (logDownload.busy ? t('menu.downloadLog.busy') : undefined)
    sessionEntries.push({
      kind: 'item',
      id: DOWNLOAD_LOG_ID,
      label: t('menu.downloadLog'),
      note,
      icon: <IconDownloadOutline16 />,
      disabled: note !== undefined,
    })
  }
  if (shown(settings.showArchive)) {
    sessionEntries.push({
      kind: 'item',
      id: 'archive',
      label: t('menu.archive'),
      note: target === undefined ? t('menu.noSession') : undefined,
      icon: <IconArchiveOutline20 size={16} />,
      disabled: target === undefined,
    })
  }
  if (shown(settings.showDelete)) {
    sessionEntries.push({
      kind: 'item',
      id: 'delete',
      label: t('menu.delete'),
      note: target === undefined ? t('menu.noSession') : undefined,
      icon: <IconTrashOutline16 />,
      danger: true,
      disabled: target === undefined,
    })
  }
  if (sessionEntries.length > 0) {
    if (items.length > 0) items.push({ kind: 'separator', id: 'sep-session' })
    items.push(...sessionEntries)
  }

  if (items.length === 0) return null

  const onSelect = (id: string): void => {
    if (target === undefined) return
    if (id === NEW_WINDOW_ID) { actions.openWindow(); return }
    if (id.startsWith(OPEN_IN_PREFIX)) {
      if (directory === undefined) return
      void actions.openIn(id.slice(OPEN_IN_PREFIX.length), directory)
      return
    }
    if (id === DOWNLOAD_LOG_ID) { actions.downloadLog(target.sessionId); return }
    if (id === 'archive') { void actions.archive(target); return }
    if (id === 'delete') { void actions.requestDelete(target); return }
    if (id === 'changes' || id === 'terminal' || id === 'files' || id === 'tasks' || id === 'preview') {
      actions.openPanel(id, target)
    }
    // Any other id is the `open-in` parent row, which the menu reports only when it has no
    // submenu — and it always has one here, so nothing is left to dispatch.
  }

  const label = t('menu.trigger')
  return (
    <>
      <Button
        ref={triggerRef}
        size="icon"
        className={cx(css.trigger, open && css.triggerOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={target === undefined ? label : t('menu.aria', { name: target.title })}
        title={label}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconEllipsisOutline16 />
      </Button>
      <DropdownMenu
        open={open}
        onClose={() => { setOpen(false) }}
        anchorRef={triggerRef}
        items={items}
        onSelect={onSelect}
        // The header sits at the top right of the frame, so the list hangs below it and lines its
        // right edge up with the trigger's.
        side="bottom"
        align="end"
        label={label}
      />
    </>
  )
}
