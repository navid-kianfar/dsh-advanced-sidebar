/**
 * Advanced sidebar plugin, browser half: four registrations over one Host endpoint and one shared
 * piece of state.
 *
 * - `sidebar.footer.action` — the More actions trigger beside Settings.
 * - `conversation.session.header.utilities` — the same menu on the open session.
 * - `shell.overlay` — the drawer holding whichever panel is open, plus the Delete confirmation.
 * - `settings.plugin.item` — the card on the plugin-configuration tab, keyed by the namespace.
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
// Type-only: the SlotMap merges of the four slots occupied below.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// The generated Host-for-Client contract for this plugin's own endpoint. Importing it here — rather
// than adding a row to the curated api-remotes assembly — is what keeps the capability a plugin: the
// namespace mounts and unmounts with this fiber, and no shipped source names `advancedSidebar`.
import sidebarRemote from '../../generated/typert.remote-client.js'
import type { AdvancedSidebarSettings } from '../host/types.ts'
import { LOCALE_NS, SETTINGS_NS, type MenuInjected, type PanelHostInjected, type SettingsCardInjected } from './contract.ts'
import { PanelController, type OperationTarget } from './controller.ts'
import { PanelHost } from './PanelHost.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { HeaderMenu, SidebarMenu } from './Seats.tsx'
import { en, zh } from './locales.ts'

export type { AdvancedSidebarKey } from './locales.ts'
export type {
  HeaderMenuProps, MenuInjected, PanelHostInjected, PanelHostProps, SettingsCardInjected,
  SettingsCardProps, SidebarMenuProps, Translate,
} from './contract.ts'
export type { OperationTarget, PanelKind, SidebarState } from './controller.ts'

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
 * Register the four seats against a context that has the namespace.
 * @param ctx - the child fiber, with `remote.advancedSidebar` injected.
 */
function surface(ctx: ClientContext): void {
  const controller = new PanelController()
  ctx.effect(() => () => { controller.reset() }, 'advanced-sidebar: panel state')

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

  /** Report one failure as a notice; used wherever there is no panel to render it in. */
  const failed = (reason: unknown): void => {
    controller.notify('error', reason instanceof Error ? reason.message : String(reason))
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
      controller.forget(target.sessionId)
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
      controller.forget(target.sessionId)
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
    hooks: { sidebar: controller, settings: scope },
    describe,
    openPanel: (panel, target) => { controller.open(panel, target) },
    openIn,
    // A second window of the same page: the Web Client is a normal browser document, so this needs
    // no Host involvement at all.
    openWindow: () => { window.open(window.location.href, '_blank', 'noopener,noreferrer') },
    archive,
    requestDelete,
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'advanced-sidebar',
    // After any shipped footer action: this is an addition to the column, not a replacement of
    // whatever a deployment already put there.
    order: 50,
    locale: LOCALE_NS,
    inject: menuInjected,
  }, SidebarMenu))

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
      dismissNotice: (id) => { controller.dismissNotice(id) },
      dismissDelete: () => { controller.dismissDelete() },
      forgetSession: (sessionId) => { controller.forget(sessionId) },
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
