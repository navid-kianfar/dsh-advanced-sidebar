/**
 * The registrant-side contracts of this plugin's four slot entries: what each component is handed,
 * and the props type it composes from the framework's shares.
 *
 * Each face is the whole business surface of one seat. Components never reach a cordis service —
 * the `apply` closes over `ctx` and hands plain callbacks down, which is what lets every one of
 * these render in a test with no context at all.
 * @module @achasoft/dsh-advanced-sidebar/client/contract
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotMap merges of the three slots these entries occupy.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {
  AdvancedSidebarSettings, AdvancedSidebarView, DeleteSessionResult, GitCommitMessageResult,
  GitCommitResult, GitDiffRequest, GitDiffResult, GitPushResult, GitStageResult,
  GitStatusResult, ListEntriesResult, PreviewListResult, PreviewLogsResult, PreviewStartResult,
  PreviewStopResult, ReadFileResult, TaskKillResult, TaskOutputResult,
  TerminalAckResult, TerminalOpenResult, TerminalReadResult,
} from '../host/types.ts'
import type { OperationTarget, PanelController, PanelKind } from './controller.ts'
import type { AdvancedSidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the session menu, the dock's five panels, the delete dialog, and the settings card. */
    advancedSidebar: AdvancedSidebarKey
  }
}

/**
 * This package's translator, declared once so every component types its `t` seat from the same
 * place as the framework-synthesized one.
 */
export type Translate = TranslateNS<'advancedSidebar'>

/** The dictionary namespace this plugin owns; also its settings namespace's camelCase twin. */
export const LOCALE_NS = 'advancedSidebar'

/** The settings namespace the Host section is registered under (kebab-case, as that grammar requires). */
export const SETTINGS_NS = 'advanced-sidebar'

/** The Remote namespace, read as `ctx.remote.advancedSidebar.…`. */
export const REMOTE_NS = 'advancedSidebar'

/** Everything the session header's menu seat needs. */
export interface MenuInjected {
  /** Registrant-private reactive sources the renderer binds to `use<Name>` hooks. */
  hooks: {
    /** Cross-registration panel state; the menu writes it and the dock reads it. */
    sidebar: PanelController
    /** The bound `advanced-sidebar` settings scope, which decides the menu's entries. */
    settings: SettingsScope<AdvancedSidebarSettings>
  }
  /**
   * Read the Host's capability view so an entry can be disabled with a reason.
   * @param signal - cancellation for the probe.
   * @returns the capability view.
   */
  describe: (signal?: AbortSignal) => Promise<AdvancedSidebarView>
  /**
   * Show one panel in the dock.
   * @param panel - which panel.
   * @param target - the session and directory it acts on.
   */
  openPanel: (panel: PanelKind, target: OperationTarget) => void
  /**
   * Hand one path to an Open in target.
   * @param targetId - the target's id.
   * @param path - the absolute Host path.
   * @returns after the launch settled; a failure surfaces as a notice.
   */
  openIn: (targetId: string, path: string) => Promise<void>
  /** Open the Web Client in a second browser window. */
  openWindow: () => void
  /**
   * Archive one session.
   * @param target - the session to hide.
   * @returns after the registry committed; a failure surfaces as a notice.
   */
  archive: (target: OperationTarget) => Promise<void>
  /**
   * Begin Delete: ask the Host what it would do, then confirm or commit per the settings.
   * @param target - the session to delete.
   * @returns after the confirmation opened, or after an unconfirmed delete committed.
   */
  requestDelete: (target: OperationTarget) => Promise<void>
}

/** Full props of the session-header trigger. */
export type HeaderMenuProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'advancedSidebar'> & InjectFace<MenuInjected>

/** Everything the dock and its confirmation dialog need. */
export interface PanelHostInjected {
  /** Registrant-private reactive sources the renderer binds to `use<Name>` hooks. */
  hooks: {
    /** Cross-registration panel state; the dock reads it and its own controls write it. */
    sidebar: PanelController
    /** The bound settings scope, which decides the dock's width and which verbs it offers. */
    settings: SettingsScope<AdvancedSidebarSettings>
  }
  /**
   * Read the Host's capability view for the dock's own gating.
   * @param signal - cancellation for the probe.
   * @returns the capability view.
   */
  describe: (signal?: AbortSignal) => Promise<AdvancedSidebarView>
  /**
   * Read one workspace's git status.
   * @param workspacePath - the directory to read.
   * @param signal - cancellation for the reading.
   * @returns the reading, or a classified failure.
   */
  gitStatus: (workspacePath: string, signal?: AbortSignal) => Promise<GitStatusResult>
  /**
   * Read one path's patch.
   * @param request - the path and which index to compare.
   * @param signal - cancellation for the reading.
   * @returns the patch, or a classified failure.
   */
  gitDiff: (request: GitDiffRequest, signal?: AbortSignal) => Promise<GitDiffResult>
  /**
   * Stage paths into the index.
   * @param workspacePath - the workspace the reading came from.
   * @param paths - repository-relative paths.
   * @returns the reading after the write, or a classified failure.
   */
  gitStage: (workspacePath: string, paths: readonly string[]) => Promise<GitStageResult>
  /**
   * Take paths back out of the index.
   * @param workspacePath - the workspace the reading came from.
   * @param paths - repository-relative paths.
   * @returns the reading after the write, or a classified failure.
   */
  gitUnstage: (workspacePath: string, paths: readonly string[]) => Promise<GitStageResult>
  /**
   * Record the staged changes.
   * @param workspacePath - the workspace the reading came from.
   * @param message - the commit message.
   * @param amend - replace the previous commit instead of adding one.
   * @returns the new commit and the reading after it, or a classified failure.
   */
  gitCommit: (workspacePath: string, message: string, amend: boolean) => Promise<GitCommitResult>
  /**
   * Send the current branch's commits to its remote.
   * @param workspacePath - the workspace the reading came from.
   * @param setUpstream - publish a branch that has no upstream instead of refusing it.
   * @returns the push and the reading after it, or a classified failure.
   */
  gitPush: (workspacePath: string, setUpstream: boolean) => Promise<GitPushResult>
  /**
   * Ask the deployment's model to write a commit message for what is staged.
   * @param workspacePath - the workspace the reading came from.
   * @param amend - draft for an amend, which describes the previous commit's content too.
   * @param signal - cancellation for the readings and the model call.
   * @returns the drafted message, or a classified failure.
   */
  gitCommitMessage: (
    workspacePath: string, amend: boolean, signal?: AbortSignal,
  ) => Promise<GitCommitMessageResult>
  /**
   * Allocate a panel terminal.
   * @param workspacePath - the directory to start in.
   * @param cols - measured column count.
   * @param rows - measured row count.
   * @returns the handle, or a classified failure.
   */
  terminalOpen: (workspacePath: string, cols: number, rows: number) => Promise<TerminalOpenResult>
  /**
   * Read terminal output from the offset already rendered.
   * @param terminalId - the handle.
   * @param fromOffset - the rendered offset.
   * @returns the delta, or a classified failure.
   */
  terminalRead: (terminalId: string, fromOffset: number) => Promise<TerminalReadResult>
  /**
   * Send keystrokes.
   * @param terminalId - the handle.
   * @param data - text delivered verbatim.
   * @returns settlement, or a classified failure.
   */
  terminalWrite: (terminalId: string, data: string) => Promise<TerminalAckResult>
  /**
   * Interrupt the terminal's foreground process group.
   * @param terminalId - the handle.
   * @returns settlement, or a classified failure.
   */
  terminalInterrupt: (terminalId: string) => Promise<TerminalAckResult>
  /**
   * Close a terminal.
   * @param terminalId - the handle.
   * @returns settlement, or a classified failure.
   */
  terminalClose: (terminalId: string) => Promise<TerminalAckResult>
  /**
   * List one directory level inside a workspace.
   * @param path - absolute directory.
   * @param workspacePath - the directory the listing must stay inside.
   * @param signal - cancellation for the listing.
   * @returns the level, or a classified failure.
   */
  listEntries: (path: string, workspacePath: string, signal?: AbortSignal) => Promise<ListEntriesResult>
  /**
   * Read one file for preview.
   * @param path - the file.
   * @param workspacePath - the directory it must stay inside.
   * @param signal - cancellation for the read.
   * @returns the preview, or a classified failure.
   */
  readFile: (path: string, workspacePath: string, signal?: AbortSignal) => Promise<ReadFileResult>
  /**
   * List one workspace's preview launch configurations, each with its current state.
   * @param workspacePath - the workspace to read.
   * @param signal - cancellation for the read.
   * @returns the list, or a classified failure.
   */
  previewList: (workspacePath: string, signal?: AbortSignal) => Promise<PreviewListResult>
  /**
   * Start one preview configuration.
   * @param workspacePath - the workspace it belongs to.
   * @param name - the configuration name.
   * @returns the started row, or a classified failure.
   */
  previewStart: (workspacePath: string, name: string) => Promise<PreviewStartResult>
  /**
   * Stop one running preview server.
   * @param serverId - the handle.
   * @returns settlement, or a classified failure.
   */
  previewStop: (serverId: string) => Promise<PreviewStopResult>
  /**
   * Read one preview server's output from the offset already rendered, with its state.
   * @param serverId - the handle.
   * @param fromOffset - the rendered offset.
   * @returns the delta and the state, or a classified failure.
   */
  previewLogs: (serverId: string, fromOffset: number) => Promise<PreviewLogsResult>
  /**
   * Open one path with the Host operating system's default application.
   * @param path - the absolute path.
   * @returns after the Host answered; a failure surfaces as a notice.
   */
  openPath: (path: string) => Promise<void>
  /**
   * Hand one path to an Open in target.
   * @param targetId - the target's id.
   * @param path - the absolute path.
   * @returns after the launch settled.
   */
  openIn: (targetId: string, path: string) => Promise<void>
  /**
   * Stop one live background task.
   * @param sessionId - the owning session.
   * @param taskId - the task.
   * @returns what the registry did, or a classified failure.
   */
  taskKill: (sessionId: string, taskId: string) => Promise<TaskKillResult>
  /**
   * Read one settled task's output.
   * @param sessionId - the owning session.
   * @param taskId - the task.
   * @returns the output, or a classified failure.
   */
  taskOutput: (sessionId: string, taskId: string) => Promise<TaskOutputResult>
  /**
   * Commit the pending Delete.
   * @param sessionId - the session to delete.
   * @returns what was done, or a classified failure.
   */
  deleteSession: (sessionId: string) => Promise<DeleteSessionResult>
  /**
   * Copy text to the clipboard.
   * @param text - the text to copy.
   * @returns whether the browser accepted it.
   */
  copy: (text: string) => Promise<boolean>
  /** Close the dock. */
  close: () => void
  /**
   * Store the width a resize settled on, for this browser session.
   * @param width - the width in pixels.
   */
  setDockWidth: (width: number) => void
  /**
   * Persist the width a resize settled on into the settings section.
   * @param width - the width in pixels.
   * @returns settlement after the write; refused scopes reject and the dock keeps its own copy.
   */
  setPanelWidth: (width: number) => Promise<void>
  /**
   * Add one terminal tab, in the state it has before its shell has been allocated.
   * @param key - the terminal group key.
   * @param tabId - the caller-generated tab id the allocation will be recorded against.
   */
  addTerminal: (key: string, tabId: string) => void
  /**
   * Record what one tab's allocation answered.
   * @param key - the terminal group key.
   * @param tabId - the tab the allocation was for.
   * @param outcome - the handle and the shell, or the failure.
   */
  settleTerminal: (
    key: string, tabId: string, outcome: { terminalId: string; shell: string } | { error: string },
  ) => void
  /**
   * Show one tab's screen.
   * @param key - the terminal group key.
   * @param tabId - the tab to show.
   */
  activateTerminal: (key: string, tabId: string) => void
  /**
   * Drop one tab and close the shell it held.
   * @param key - the terminal group key.
   * @param tabId - the tab to close.
   * @returns after the Host answered; a failure surfaces as a notice.
   */
  closeTerminal: (key: string, tabId: string) => Promise<void>
  /**
   * Dismiss one notice, ignoring a request for one already replaced.
   * @param id - the notice to dismiss.
   */
  dismissNotice: (id: number) => void
  /** Dismiss the Delete confirmation without acting. */
  dismissDelete: () => void
  /**
   * Withdraw everything a session owned, because that session left the list.
   * @param sessionId - the session that disappeared.
   */
  forgetSession: (sessionId: string) => void
  /**
   * Commit the confirmed Delete and report its outcome as a notice.
   * @param target - the session to delete.
   * @returns after the Host answered.
   */
  commitDelete: (target: OperationTarget) => Promise<void>
  /**
   * Report one message under the dock.
   * @param tone - whether the message reports a failure.
   * @param text - the message.
   */
  notify: (tone: 'info' | 'error', text: string) => void
}

/** Full props of the frame-wide dock. */
export type PanelHostProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'advancedSidebar'> & InjectFace<PanelHostInjected>

/** Everything the settings card needs. */
export interface SettingsCardInjected {
  /** Registrant-private reactive sources the renderer binds to `use<Name>` hooks. */
  hooks: {
    /** The bound `advanced-sidebar` settings scope: resolved value, layers, revision, writability. */
    sidebarSettings: SettingsScope<AdvancedSidebarSettings>
  }
  /**
   * Read the Host's capability view for the card's status line and its Open in roster.
   * @param signal - cancellation for the probe.
   * @returns the capability view.
   */
  describe: (signal?: AbortSignal) => Promise<AdvancedSidebarView>
  /**
   * Store one field of the section; the bound scope owns revision fencing.
   * @param field - the field name inside the namespace.
   * @param value - the JSON-shaped value the control produced.
   * @returns settlement after the write.
   */
  setField: (field: string, value: unknown) => Promise<void>
  /**
   * Clear one optional field back to the composition layer.
   * @param field - the field name inside the namespace.
   * @returns settlement after the write.
   */
  unsetField: (field: string) => Promise<void>
}

/** Full props of the plugin-settings card. */
export type SettingsCardProps =
  PropsRuntime<'settings.plugin.item'> & PropsLocale<'advancedSidebar'> & InjectFace<SettingsCardInjected>
