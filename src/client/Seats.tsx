/**
 * The menu seat: the session header's utilities row.
 *
 * There was a second seat at the sidebar foot. It was withdrawn — the same menu in two places gave
 * the column an action whose target was whatever session happened to be current, which is not what
 * a column of sessions reads as; the header's menu acts on the session it sits in.
 * @module @achasoft/dsh-advanced-sidebar/client/Seats
 */

import { useMemo } from 'react'
import type { HeaderMenuProps } from './contract.ts'
import { ActionMenu } from './ActionMenu.tsx'
import { isDownloading } from './log-download.ts'
import { resolveTarget } from './target.ts'
import { useCapabilityView } from './use-capability.ts'

/**
 * The session header's trigger. Session-scoped, so the framework supplies the session id.
 * @param props - the standard kit for a session seat plus this plugin's face.
 * @returns the trigger and its menu, or null while the settings section switches it off.
 * @see {@link HeaderMenuProps}
 */
export function HeaderMenu(props: HeaderMenuProps) {
  const { sessionId, useSessions, useWorkspaces, useSettings, useSidebar, useLogDownload, t, describe } = props
  const bound = useSettings(snapshot => snapshot.value)
  const sessions = useSessions(state => state)
  const workspaces = useWorkspaces(state => state)
  // Subscribed so the entry of the open panel carries its check mark, and so choosing it again
  // reads as the toggle it is.
  const openPanel = useSidebar(state => state.panel.panel)
  // Two primitive selections rather than one object, so neither allocates a fresh snapshot per read.
  const logsActive = useLogDownload(state => state.active)
  const logsBusy = useLogDownload(state => isDownloading(state, String(sessionId)))
  // Fetched unconditionally, because the fallback below depends on it: gating the probe on the
  // settings value would leave a client that cannot read settings with neither source.
  const { view, refresh } = useCapabilityView(describe)
  // The bound scope where it resolves, the Host's own copy otherwise. `ctx.settingsScope` answers
  // `unavailable` with no value on every non-loopback Web Client, and a surface that took that as
  // "switched off" would disappear entirely for remote access.
  const settings = bound ?? view?.settings

  const target = useMemo(
    () => resolveTarget(sessions, workspaces, sessionId),
    [sessions, workspaces, sessionId],
  )

  if (settings === undefined) return null
  // Switched out of the header, the menu still owns the harness's download button it shadows: it
  // renders as that button — Download session log alone — rather than removing the verb with it.
  const logsOnly = !settings.showInSessionHeader
  if (logsOnly && !logsActive) return null
  return (
    <ActionMenu
      target={target}
      settings={settings}
      view={view}
      t={t}
      actions={props}
      refresh={refresh}
      openPanel={openPanel}
      logDownload={{ active: logsActive, busy: logsBusy }}
      logsOnly={logsOnly}
    />
  )
}
