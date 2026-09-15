/**
 * Advanced sidebar plugin, browser half: three registrations over one Host endpoint and one shared
 * piece of state.
 *
 * - `conversation.session.header.utilities` — the menu on the open session, and, in the same row,
 *   the entry shadowing the harness's own session-log download button, whose verb the menu absorbs.
 * - `shell.overlay` — the resizable dock holding whichever panel is open, plus the Delete
 *   confirmation.
 * - `settings.plugin.item` — the card on the plugin-configuration tab, keyed by the namespace.
 *
 * There was a fourth, at the sidebar foot; it was withdrawn, so the column has no action of this
 * plugin's in it and the menu acts only on the session it sits in.
 *
 * The seats have no common React ancestor, so what a person opened lives in a {@link PanelController}
 * this module owns and hands to each registration through its inject face. Archiving and directory
 * navigation go through the Web Client's own `ctx.workspaces`; everything a browser structurally
 * cannot do goes through this plugin's own Remote namespace.
 * @module @achasoft/dsh-advanced-sidebar/client
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge and the generated `advancedSidebar` namespace.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the SlotMap merges of the three slots occupied below.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// The generated Host-for-Client contract for this plugin's own endpoint. Importing it here — rather
// than adding a row to the curated api-remotes assembly — is what keeps the capability a plugin: the
// namespace mounts and unmounts with this fiber, and no shipped source names `advancedSidebar`.
import sidebarRemote from '../../generated/typert.remote-client.js'
import type { AdvancedSidebarSettings } from '../host/types.ts'
import {
  LOCALE_NS, SETTINGS_NS, type LogDownloadSeatInjected, type MenuInjected, type PanelHostInjected,
  type SettingsCardInjected,
} from './contract.ts'
import { PanelController, type OperationTarget } from './controller.ts'
import { PanelHost } from './PanelHost.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { HeaderMenu } from './Seats.tsx'
import { LogDownloadDialog } from './LogDownloadDialog.tsx'
import {
  asLogDownloadService, LogDownloadBridge, LOG_DOWNLOAD_SEAT_ID, LOG_DOWNLOAD_SERVICE,
  LOG_DOWNLOAD_SHADOW_PRIORITY, LOG_DOWNLOAD_SLOT, shadowsHarnessSeat,
} from './log-download.ts'
import { en, zh } from './locales.ts'

export type { AdvancedSidebarKey } from './locales.ts'
export type {
  HeaderMenuProps, LogDownloadSeatInjected, LogDownloadSeatProps, MenuInjected, PanelHostInjected,
  PanelHostProps, SettingsCardInjected, SettingsCardProps, Translate,
} from './contract.ts'
export type { LogDownloadEntry, LogDownloadState, LogDownloadView } from './log-download.ts'
export type {
  OperationTarget, PanelKind, SidebarState, TerminalGroup, TerminalTab,
} from './controller.ts'

/**
 * Required services of the OUTER plugin: locale and the Remote mount point.
 *
 * Deliberately NOT `remote.advancedSidebar`. This plugin's apply creates that namespace by mounting
 * its own contribution, so it cannot also wait for it — and Cordis refuses to read a service the
 * fiber did not inject. Both halves of that bind are resolved by the child plugin below, which
 * injects `remote.advancedSidebar` after the parent has provided it.
 */
export const inject = ['locale', 'remote']

/**
 * Client plugin body: mount this plugin's Remote namespace, register the dictionaries, then hand
 * the surface to a child fiber that can inject the namespace its parent just provided.
 * @param ctx - client root context.
 * @returns after the `advancedSidebar` namespace is callable; its methods are withdrawn when this
 * fiber unloads.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // Mounted on THIS fiber, so the endpoint's lifetime is the plugin's.
  await ctx.remote.$mount(sidebarRemote)
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'advanced-sidebar: dictionaries')

  ctx.plugin({
    name: 'advanced-sidebar-surface',
    inject: ['slots', 'settingsScope', 'sessions', 'workspaces', 'locale', 'remote', 'remote.advancedSidebar'],
    apply: surface,
  })
}

/**
 * Register the three seats against a context that has the namespace.
 * @param ctx - the child fiber, with `remote.advancedSidebar` injected.
 */
function surface(ctx: ClientContext): void {
  const controller = new PanelController()
  const logDownload = new LogDownloadBridge()

  // Every endpoint returns the carrier's RemoteResult envelope. A transport failure is a different
  // fact from a business failure, so it is thrown rather than folded into the union the Host
  // defines: each panel catches it and shows the RPC diagnostic verbatim.
  const unwrap = <T>(result: RemoteResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.message} (${result.error.code})`)
    return result.value
  }
  const remote = ctx.remote.advancedSidebar
  const describe = (signal?: AbortSignal) => remote.describe(signal).then(unwrap)
  const scope = ctx.settingsScope.bind<AdvancedSidebarSettings>({ namespace: SETTINGS_NS })

  // Panel terminals outlive the panel that opened them, so teardown is what reaps them. The Host
  // also closes every one of its own on unload; this covers the case where only the browser half
  // is replaced, which is what a development reload does.
  ctx.effect(() => () => {
    for (const terminalId of controller.allTerminals()) void remote.terminalClose({ terminalId })
    controller.reset()
  }, 'advanced-sidebar: panel state and open terminals')

  /** Report one failure as a notice; used wherever there is no panel to render it in. */
  const failed = (reason: unknown): void => {
    controller.notify('error', reason instanceof Error ? reason.message : String(reason))
  }

  /** Close one shell the Host still holds, reporting a refusal as a notice. */
  const closeShell = async (terminalId: string): Promise<void> => {
    try {
      const result = await remote.terminalClose({ terminalId }).then(unwrap)
      // `unknown-terminal` is the ordinary answer for a shell the Host already reaped, and the tab
      // it belonged to is gone either way.
      if (!result.ok && result.code !== 'unknown-terminal') controller.notify('error', result.message)
    } catch (error) {
      failed(error)
    }
  }

  /**
   * Withdraw everything one session owned, including the shells opened in its directory: the
   * session is gone, so nothing in the browser could reach them again.
   */
  const forgetSession = (sessionId: string): void => {
    for (const terminalId of controller.dropTerminals(sessionId)) void closeShell(terminalId)
    controller.forget(sessionId)
  }

  const openIn = async (targetId: string, path: string): Promise<void> => {
    try {
      const result = await remote.openIn({ targetId, path }).then(unwrap)
      if (!result.ok) controller.notify('error', result.message)
    } catch (error) {
      failed(error)
    }
  }

  const archive = async (target: OperationTarget): Promise<void> => {
    try {
      await ctx.workspaces.archiveSession(target.sessionId as Parameters<typeof ctx.workspaces.archiveSession>[0])
      forgetSession(target.sessionId)
      controller.notify('info', ctx.locale.bind(LOCALE_NS)('archive.done', { name: target.title }))
    } catch (error) {
      failed(error)
    }
  }

  const commitDelete = async (target: OperationTarget): Promise<void> => {
    const t = ctx.locale.bind(LOCALE_NS)
    controller.markDeleting()
    try {
      const result = await remote.deleteSession({ sessionId: target.sessionId }).then(unwrap)
      controller.dismissDelete()
      if (!result.ok) { controller.notify('error', result.message); return }
      forgetSession(target.sessionId)
      if (result.purged) {
        controller.notify('info', t('delete.done.purge', { name: target.title }))
      } else if (result.purgeSkippedReason !== undefined) {
        controller.notify('info', t('delete.done.kept', { name: target.title, reason: result.purgeSkippedReason }))
      } else {
        controller.notify('info', t('delete.done.archive', { name: target.title }))
      }
    } catch (error) {
      controller.dismissDelete()
      failed(error)
    }
  }

  const requestDelete = async (target: OperationTarget): Promise<void> => {
    let purges = false
    try {
      purges = (await describe()).deletion.mode === 'purge'
    } catch (error) {
      // A failed probe must not turn an archive-only delete into a silent one: the confirmation is
      // shown with the safer wording rather than skipped.
      failed(error)
    }
    const settings = scope.getSnapshot().value
    if (settings?.confirmDelete === false && !purges) {
      await commitDelete(target)
      return
    }
    controller.askDelete(target, purges)
  }

  const menuInjected = (): MenuInjected => ({
    hooks: { sidebar: controller, settings: scope, logDownload },
    describe,
    openPanel: (panel, target) => { controller.open(panel, target) },
    openIn,
    // A second window of the same page: the Web Client is a normal browser document, so this needs
    // no Host involvement at all.
    openWindow: () => { window.open(window.location.href, '_blank', 'noopener,noreferrer') },
    archive,
    requestDelete,
    downloadLog: (sessionId) => {
      // The entry is offered only while the bridge is active, so a detached answer here means the
      // package unloaded between the menu opening and the click; a notice beats a silent no-op.
      if (!logDownload.download(sessionId)) controller.notify('error', ctx.locale.bind(LOCALE_NS)('menu.downloadLog.unavailable'))
    },
  })

  /**
   * Download session log, absorbed from `@deepseek-ai/dsh-session-log-export` (see
   * `log-download.ts` for the whole rationale).
   *
   * Its own child fiber, injecting the harness's `sessionLogDownload` service, because that service
   * is optional and may arrive after this plugin: Cordis applies the child once the service exists
   * and disposes it when the service goes, so the menu loads either way, and the shadow and the
   * bridge exist exactly while there is a controller behind them. The service is then read through
   * `ctx.get` and narrowed by shape, since its type belongs to a package this one does not depend on.
   */
  ctx.plugin({
    name: 'advanced-sidebar-log-download',
    inject: ['slots', LOG_DOWNLOAD_SERVICE],
    apply: (child: ClientContext) => {
      const service = asLogDownloadService(child.get(LOG_DOWNLOAD_SERVICE))
      // An incompatible controller: stand aside entirely, leaving the harness's button untouched.
      if (service === undefined) return
      child.effect(() => logDownload.attach(service), 'advanced-sidebar: session log export bridge')

      // The menu offers the verb only while this plugin is really hiding the harness's button, so
      // the registry is re-read on every change to the row rather than assumed once.
      child.effect(() => {
        const recheck = (): void => { logDownload.setShadowing(shadowsHarnessSeat(child.slots.entries(LOG_DOWNLOAD_SLOT))) }
        recheck()
        const unsubscribe = child.slots.subscribe(LOG_DOWNLOAD_SLOT, recheck)
        return () => {
          unsubscribe()
          logDownload.setShadowing(false)
        }
      }, 'advanced-sidebar: session log download seat watch')

      // Same id, one priority ahead: this entry takes the cell and the harness's button stops
      // rendering. It draws the export dialog the shadowed entry drew, and nothing else.
      child.slots.inject(LOG_DOWNLOAD_SLOT, () => child.slots.register({
        name: LOG_DOWNLOAD_SLOT,
        id: LOG_DOWNLOAD_SEAT_ID,
        priority: LOG_DOWNLOAD_SHADOW_PRIORITY,
        locale: LOCALE_NS,
        inject: (): LogDownloadSeatInjected => ({
          hooks: { logDownload },
          dismiss: (sessionId) => { logDownload.dismiss(sessionId) },
        }),
      }, LogDownloadDialog))
    },
  })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'advanced-sidebar',
    order: 50,
    locale: LOCALE_NS,
    inject: menuInjected,
  }, HeaderMenu))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'advanced-sidebar-panels',
    locale: LOCALE_NS,
    inject: (): PanelHostInjected => ({
      hooks: { sidebar: controller, settings: scope },
      describe,
      gitStatus: (workspacePath, signal) => remote.gitStatus({ workspacePath }, signal).then(unwrap),
      gitDiff: (request, signal) => remote.gitDiff(request, signal).then(unwrap),
      gitStage: (workspacePath, paths) => remote.gitStage({ workspacePath, paths }).then(unwrap),
      gitUnstage: (workspacePath, paths) => remote.gitUnstage({ workspacePath, paths }).then(unwrap),
      gitCommit: (workspacePath, message, amend) =>
        remote.gitCommit({ workspacePath, message, amend }).then(unwrap),
      gitPush: (workspacePath, setUpstream) =>
        remote.gitPush({ workspacePath, setUpstream }).then(unwrap),
      gitCommitMessage: (workspacePath, amend, signal) =>
        remote.gitCommitMessage({ workspacePath, amend }, signal).then(unwrap),
      terminalOpen: (workspacePath, cols, rows) => remote.terminalOpen({ workspacePath, cols, rows }).then(unwrap),
      terminalRead: (terminalId, fromOffset) => remote.terminalRead({ terminalId, fromOffset }).then(unwrap),
      terminalWrite: (terminalId, data) => remote.terminalWrite({ terminalId, data }).then(unwrap),
      terminalInterrupt: terminalId => remote.terminalSignal({ terminalId, signal: 'SIGINT' }).then(unwrap),
      terminalClose: terminalId => remote.terminalClose({ terminalId }).then(unwrap),
      listEntries: (path, workspacePath, signal) => remote.listEntries({ path, workspacePath }, signal).then(unwrap),
      previewList: (workspacePath, signal) => remote.previewList({ workspacePath }, signal).then(unwrap),
      previewStart: (workspacePath, name) => remote.previewStart({ workspacePath, name }).then(unwrap),
      previewStop: serverId => remote.previewStop({ serverId }).then(unwrap),
      previewLogs: (serverId, fromOffset) => remote.previewLogs({ serverId, fromOffset }).then(unwrap),
      previewFileInfo: (workspacePath, path, signal) =>
        remote.previewFileInfo({ workspacePath, path }, signal).then(unwrap),
      previewPoll: request => remote.previewPoll(request).then(unwrap),
      previewResult: request => remote.previewResult(request).then(unwrap),
      previewRelease: clientId => remote.previewRelease({ clientId }).then(unwrap),
      readFile: (path, workspacePath, signal) => remote.readFile({ path, workspacePath }, signal).then(unwrap),
      openPath: async (path) => {
        try {
          await ctx.workspaces.openPath(path)
        } catch (error) {
          failed(error)
        }
      },
      openIn,
      taskKill: (sessionId, taskId) => remote.taskKill({ sessionId, taskId }).then(unwrap),
      taskOutput: (sessionId, taskId) => remote.taskOutput({ sessionId, taskId }).then(unwrap),
      deleteSession: sessionId => remote.deleteSession({ sessionId }).then(unwrap),
      copy: async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          // A denied clipboard permission is the ordinary answer in an insecure context; the copy
          // button simply does not confirm, and the patch is still selectable on screen.
          return false
        }
      },
      close: () => { controller.close() },
      setDockWidth: (width) => { controller.setDockWidth(width) },
      setPanelWidth: width => scope.set('panelWidth', width),
      addTerminal: (key, tabId) => { controller.addTerminal(key, tabId) },
      settleTerminal: (key, tabId, outcome) => { controller.settleTerminal(key, tabId, outcome) },
      activateTerminal: (key, tabId) => { controller.activateTerminal(key, tabId) },
      closeTerminal: async (key, tabId) => {
        const terminalId = controller.removeTerminal(key, tabId)
        if (terminalId !== undefined) await closeShell(terminalId)
      },
      dismissNotice: (id) => { controller.dismissNotice(id) },
      dismissDelete: () => { controller.dismissDelete() },
      forgetSession,
      commitDelete,
      notify: (tone, text) => { controller.notify(tone, text) },
    }),
  }, PanelHost))

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SETTINGS_NS,
    locale: LOCALE_NS,
    inject: (): SettingsCardInjected => ({
      hooks: { sidebarSettings: scope },
      describe,
      setField: (field, value) => scope.set(field, value),
      unsetField: field => scope.unset(field),
    }),
  }, SettingsCard))
}
