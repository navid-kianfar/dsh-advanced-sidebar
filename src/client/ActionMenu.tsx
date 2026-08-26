/**
 * The advanced-operations menu itself — the one component both seats render.
 *
 * Entries are built from two independent facts: what the settings section switched on, and what the
 * Host reported it can serve. A switched-off entry is absent; an entry the Host cannot serve is
 * present but disabled and carries the reason beside its label, because a person who configured an
 * editor and sees no row cannot tell a typo from a feature that does not exist.
 * @module @achasoft/dsh-advanced-sidebar/client/ActionMenu
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconArchiveOutline20, IconEllipsisOutline16, IconFolderOpenOutline16, IconQueueOutline14,
  IconTrashOutline16, Menu, type MenuEntry, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AdvancedSidebarSettings, AdvancedSidebarView } from '../host/types.ts'
import type { MenuInjected, Translate } from './contract.ts'
import type { OperationTarget, PanelKind } from './controller.ts'
import { ChangesGlyph, ExternalGlyph, TerminalGlyph } from './Glyphs.tsx'
import { cx } from './cx.ts'
import css from './ActionMenu.module.css'

/** Submenu ids are namespaced, because `Menu` reports every selection through one flat handler. */
const OPEN_IN_PREFIX = 'open-in:'

/** The Open in entry for a second browser window; not a Host target, so it has no configured id. */
const NEW_WINDOW_ID = `${OPEN_IN_PREFIX}new-window`

/** How the trigger is drawn. */
export type ActionMenuVariant =
  /** Sidebar foot, expanded column: a 42px row with an icon and a label. */
  | 'sidebar-wide'
  /** Sidebar foot, 56px rail: a 36px circle with the icon alone. */
  | 'sidebar-rail'
  /** Session header: a compact square icon button. */
  | 'header'

/** Everything the menu renders from, plus the callbacks it fires. */
export interface ActionMenuProps {
  /** Trigger geometry. */
  variant: ActionMenuVariant
  /** The session and directory every entry acts on; absent disables everything but the trigger. */
  target: OperationTarget | undefined
  /** The resolved settings section; absent while the scope is still loading. */
  settings: AdvancedSidebarSettings | undefined
  /** The Host capability view; absent until the first probe answers. */
  view: AdvancedSidebarView | undefined
  /** The namespace translator. */
  t: Translate
  /** Business callbacks, minus the reactive sources the seats bind themselves. */
  actions: Pick<MenuInjected, 'openPanel' | 'openIn' | 'openWindow' | 'archive' | 'requestDelete'>
  /** Ask the Host for a fresh capability view; called each time the menu opens. */
  refresh: () => void
}

/** One menu row's label, with the reason it is unavailable beside it. */
function Row({ label, note }: { label: string; note?: string | undefined }): ReactNode {
  return (
    <span className={css.row}>
      <span className={css.rowLabel}>{label}</span>
      {note !== undefined && <span className={css.rowNote}>{note}</span>}
    </span>
  )
}

/**
 * The trigger plus its menu.
 * @param props - geometry, target, settings, capability view, translator, and callbacks.
 * @returns the menu element, or null when the settings section switched both seats off.
 * @see {@link ActionMenuProps}
 */
export function ActionMenu(props: ActionMenuProps) {
  const { variant, target, settings, view, t, actions, refresh } = props
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // The trigger owns its own rect: `Menu`'s wrapper span is not laid out at the button in the
  // rail's centered flex box, and measuring it there places the list against the wrong edge.
  const anchorRect = useCallback(
    () => triggerRef.current?.getBoundingClientRect() ?? null,
    [],
  )

  // A capability probe per open, not per mount: git can be installed, an editor can appear, and a
  // menu that answered once at boot would keep reporting the state of that moment forever.
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  // A target that disappears under an open menu (the session was archived from elsewhere) leaves
  // every entry acting on nothing; closing is the only honest response.
  useEffect(() => {
    if (open && target === undefined) setOpen(false)
  }, [open, target])

  if (settings === undefined) return null

  const directory = target?.directory
  const unavailable = (state: { available: boolean; reason?: string } | undefined): string | undefined => {
    if (target === undefined) return t('menu.noSession')
    if (directory === undefined) return t('menu.noDirectory')
    if (state === undefined) return undefined
    return state.available ? undefined : (state.reason ?? t('settings.unavailable'))
  }

  const items: MenuEntry[] = []
  const panelRow = (
    id: PanelKind, key: Parameters<Translate>[0], icon: ReactNode,
    state: { available: boolean; reason?: string } | undefined,
  ): void => {
    const note = unavailable(state)
    items.push({
      id,
      label: <Row label={t(key)} note={note} />,
      icon,
      disabled: note !== undefined,
    })
  }

  if (settings.showChanges) panelRow('changes', 'menu.changes', <ChangesGlyph size={16} />, view?.git)
  if (settings.showTerminal) panelRow('terminal', 'menu.terminal', <TerminalGlyph size={16} />, view?.terminal)
  if (settings.showFiles) panelRow('files', 'menu.files', <IconFolderOpenOutline16 />, view?.files)
  if (settings.showTasks) {
    // The tasks panel needs a session, not a directory: a background task belongs to a session
    // whether or not that session ever had a working tree.
    const note = target === undefined
      ? t('menu.noSession')
      : (view?.tasks.available === false ? (view.tasks.reason ?? t('settings.unavailable')) : undefined)
    items.push({
      id: 'tasks',
      label: <Row label={t('menu.tasks')} note={note} />,
      icon: <IconQueueOutline14 size={16} />,
      disabled: note !== undefined,
    })
  }

  if (settings.showOpenIn) {
    const submenu: MenuItem[] = [{ id: NEW_WINDOW_ID, label: t('menu.openIn.newWindow') }]
    for (const entry of view?.openIn ?? []) {
      submenu.push({
        id: `${OPEN_IN_PREFIX}${entry.id}`,
        label: <Row label={entry.label} note={entry.available ? undefined : t('settings.editors.missing')} />,
        disabled: !entry.available || directory === undefined,
      })
    }
    if (items.length > 0) items.push({ type: 'separator', id: 'sep-open-in' })
    items.push({
      id: 'open-in',
      label: <Row label={t('menu.openIn')} />,
      icon: <ExternalGlyph size={16} />,
      submenu,
    })
  }

  const sessionEntries: MenuEntry[] = []
  if (settings.showArchive) {
    sessionEntries.push({
      id: 'archive',
      label: <Row label={t('menu.archive')} note={target === undefined ? t('menu.noSession') : undefined} />,
      icon: <IconArchiveOutline20 size={16} />,
      disabled: target === undefined,
    })
  }
  if (settings.showDelete) {
    sessionEntries.push({
      id: 'delete',
      label: <Row label={t('menu.delete')} note={target === undefined ? t('menu.noSession') : undefined} />,
      icon: <IconTrashOutline16 />,
      danger: true,
      disabled: target === undefined,
    })
  }
  if (sessionEntries.length > 0) {
    if (items.length > 0) items.push({ type: 'separator', id: 'sep-session' })
    items.push(...sessionEntries)
  }

  if (items.length === 0) return null

  const onSelect = (id: string): void => {
    setOpen(false)
    if (target === undefined) return
    if (id === NEW_WINDOW_ID) { actions.openWindow(); return }
    if (id.startsWith(OPEN_IN_PREFIX)) {
      if (directory === undefined) return
      void actions.openIn(id.slice(OPEN_IN_PREFIX.length), directory)
      return
    }
    if (id === 'archive') { void actions.archive(target); return }
    if (id === 'delete') { void actions.requestDelete(target); return }
    if (id === 'changes' || id === 'terminal' || id === 'files' || id === 'tasks') {
      actions.openPanel(id, target)
    }
    // Any other id is the `open-in` parent row, which `Menu` reports only when it has no submenu —
    // and it always has one here, so nothing is left to dispatch.
  }

  const label = t('menu.trigger')
  const wide = variant === 'sidebar-wide'
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      onSelect={onSelect}
      portal
      align={variant === 'header' ? 'end' : 'start'}
      // The sidebar foot sits at the bottom of the viewport, so its list must grow upward or it
      // would be clamped against the edge and cover the trigger it belongs to.
      side={variant === 'header' ? 'bottom' : 'top'}
      getAnchorRect={anchorRect}
      className={cx(css.menuRoot)}
      anchor={(
        <button
          ref={triggerRef}
          type="button"
          className={cx(
            css.trigger,
            variant === 'sidebar-wide' && css.triggerWide,
            variant === 'sidebar-rail' && css.triggerRail,
            variant === 'header' && css.triggerHeader,
            open && css.triggerOpen,
          )}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={target === undefined ? label : t('menu.aria', { name: target.title })}
          title={label}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconEllipsisOutline16 />
          {wide && <span className={css.triggerLabel}>{label}</span>}
        </button>
      )}
    />
  )
}
