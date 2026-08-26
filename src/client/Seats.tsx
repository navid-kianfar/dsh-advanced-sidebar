/**
 * The two menu seats: one at the sidebar foot, one in the session header.
 *
 * Both render the same {@link ActionMenu}. They differ only in where the target comes from — the
 * foot is root-scoped and resolves the current session itself, the header is handed one — and in
 * the trigger geometry each seat's surrounding chrome expects.
 * @module @achasoft/dsh-advanced-sidebar/client/Seats
 */

import { useMemo } from 'react'
import type { HeaderMenuProps, SidebarMenuProps } from './contract.ts'
import { ActionMenu } from './ActionMenu.tsx'
import { resolveTarget } from './target.ts'
import { useCapabilityView } from './use-capability.ts'

/**
 * The sidebar foot's trigger. Root-scoped, so the current session is read from the session list.
 * @param props - the shell's column state plus the standard kit and this plugin's face.
 * @returns the trigger and its menu, or null while the settings section switches it off.
 * @see {@link SidebarMenuProps}
 */
export function SidebarMenu(props: SidebarMenuProps) {
  const { wide, useSessions, useWorkspaces, useSettings, useSidebar, t, describe } = props
  const settings = useSettings(snapshot => snapshot.value)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  // Subscribed so the trigger re-renders when a drawer opens; the open drawer is what its
  // `data-open` marker reports to the rest of the column.
  const openPanel = useSidebar(state => state.panel.panel)
  const { view, refresh } = useCapabilityView(describe, settings?.showInSidebar === true)

  const current = sessions.current
  const target = useMemo(
    () => resolveTarget(sessions, workspaces, current),
    [sessions, workspaces, current],
  )

  if (settings === undefined || !settings.showInSidebar) return null
  return (
    <span data-advanced-sidebar-open={openPanel ?? undefined}>
      <ActionMenu
        variant={wide ? 'sidebar-wide' : 'sidebar-rail'}
        target={target}
        settings={settings}
        view={view}
        t={t}
        actions={props}
        refresh={refresh}
      />
    </span>
  )
}

/**
 * The session header's trigger. Session-scoped, so the framework supplies the session id.
 * @param props - the standard kit for a session seat plus this plugin's face.
 * @returns the trigger and its menu, or null while the settings section switches it off.
 * @see {@link HeaderMenuProps}
 */
export function HeaderMenu(props: HeaderMenuProps) {
  const { sessionId, useSessions, useWorkspaces, useSettings, t, describe } = props
  const settings = useSettings(snapshot => snapshot.value)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  const { view, refresh } = useCapabilityView(describe, settings?.showInSessionHeader === true)

  const target = useMemo(
    () => resolveTarget(sessions, workspaces, sessionId),
    [sessions, workspaces, sessionId],
  )

  if (settings === undefined || !settings.showInSessionHeader) return null
  return (
    <ActionMenu
      variant="header"
      target={target}
      settings={settings}
      view={view}
      t={t}
      actions={props}
      refresh={refresh}
    />
  )
}
