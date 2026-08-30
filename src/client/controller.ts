/**
 * The one piece of state shared by this plugin's four slot registrations.
 *
 * The menu trigger, the dock, and the confirmation dialog are separate slot entries with no common
 * React ancestor, so the panel a person opened cannot live in a component. It lives here, in
 * a `HostObservable` the registrations hand down through their inject faces' reserved `hooks`
 * compartment; the renderer binds each source into a `use<Name>` selector hook, so a component
 * re-renders for the slice it selected and nothing else.
 * @module @achasoft/dsh-advanced-sidebar/client/controller
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Which panel is showing in the dock. */
export type PanelKind = 'changes' | 'terminal' | 'files' | 'tasks' | 'preview'

/** The session an operation acts on, resolved once at the moment the menu is opened. */
export interface OperationTarget {
  /** Session the operation acts on. */
  readonly sessionId: string
  /** Human label for dialogs and the dock header. */
  readonly title: string
  /**
   * Absolute Host directory the panels work in: the session's own cwd, or its workspace path when
   * the session has none. Absent leaves every Host-backed entry disabled, because there is nothing
   * for git, a terminal, or a file listing to be relative to.
   */
  readonly directory: string | undefined
}

/** The open panel, if any. */
export interface PanelState {
  /** Which panel is showing; undefined while the dock is closed. */
  readonly panel: PanelKind | undefined
  /** What the panel acts on. */
  readonly target: OperationTarget | undefined
}

/** One shell the Terminal panel holds open. */
export interface TerminalTab {
  /** Identifies the tab for its whole life, including while its shell is still being allocated. */
  readonly tabId: string
  /** The Host handle; absent while the allocation is in flight or after it failed. */
  readonly terminalId: string | undefined
  /** Which shell answered. */
  readonly shell: string | undefined
  /** Why the allocation failed. */
  readonly error: string | undefined
}

/** Every shell one target's Terminal panel holds, and which of them is showing. */
export interface TerminalGroup {
  /** The tabs, in the order they were opened. */
  readonly tabs: readonly TerminalTab[]
  /** The tab whose screen is showing; absent only while the group is empty. */
  readonly activeId: string | undefined
}

/** The empty group, shared so a target with no terminals keeps one identity across renders. */
const NO_TERMINALS: TerminalGroup = { tabs: [], activeId: undefined }

/** A pending Delete waiting for confirmation. */
export interface ConfirmState {
  /** What Delete would act on. */
  readonly target: OperationTarget
  /** What the Host says Delete would actually do, so the dialog cannot promise a removal twice. */
  readonly purges: boolean
  /** True while the request is in flight; the dialog's buttons are disabled. */
  readonly busy: boolean
}

/** A short-lived message shown under the dock, for outcomes that have no surface of their own. */
export interface NoticeState {
  /** Monotonic id, so an identical repeated message still restarts the dismissal timer. */
  readonly id: number
  /** Whether the message reports a failure. */
  readonly tone: 'info' | 'error'
  /** The message. */
  readonly text: string
}

/** Everything the surfaces read. */
export interface SidebarState {
  /** The open panel. */
  readonly panel: PanelState
  /** The pending Delete confirmation. */
  readonly confirm: ConfirmState | undefined
  /** The current notice. */
  readonly notice: NoticeState | undefined
  /**
   * The dock's width in pixels after a resize, which outranks the settings value for this browser
   * session. Undefined leaves the settings section in charge.
   */
  readonly dockWidth: number | undefined
  /**
   * Terminal groups by {@link terminalKey}. Held here rather than in the panel so a shell survives
   * switching to another panel or closing the dock, exactly as a terminal in an editor does; the
   * Host retains its scrollback, so a reopened tab replays rather than restarts.
   */
  readonly terminals: Readonly<Record<string, TerminalGroup>>
}

/**
 * The key one target's terminal group is held under.
 *
 * The directory is part of it: a session whose working directory changed is a different place to
 * have a shell in, and reusing the group would leave a tab labelled with a path its shell is not in.
 * @param target - the session and directory the panel acts on.
 * @returns the group key.
 */
export function terminalKey(target: OperationTarget): string {
  return `${target.sessionId}\u0000${target.directory ?? ''}`
}

/** The initial, fully closed state. Shared so an unchanged snapshot keeps one identity. */
const CLOSED: SidebarState = {
  panel: { panel: undefined, target: undefined },
  confirm: undefined,
  notice: undefined,
  dockWidth: undefined,
  terminals: {},
}

/**
 * Holds the plugin's cross-registration state and notifies its subscribers.
 *
 * It is a plain observable rather than a cordis service: nothing outside this package reads it, and
 * a service key would be a public name for something private to four registrations.
 */
export class PanelController implements HostObservable<SidebarState> {
  private state: SidebarState = CLOSED
  private readonly listeners = new Set<() => void>()
  private nextNoticeId = 1

  /**
   * Current state.
   * @returns the snapshot; identity changes only when something actually moved.
   */
  getSnapshot(): SidebarState {
    return this.state
  }

  /**
   * Subscribe to state changes.
   * @param listener - called after every commit.
   * @returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Show one panel in the dock. Choosing the panel that is already open on the same session closes
   * the dock, which is what makes the menu entry read as a toggle.
   * @param panel - which panel.
   * @param target - what it acts on.
   */
  open(panel: PanelKind, target: OperationTarget): void {
    const current = this.state.panel
    const same = current.panel === panel && current.target?.sessionId === target.sessionId
    this.commit({ ...this.state, panel: same ? CLOSED.panel : { panel, target } })
  }

  /** Close the dock. */
  close(): void {
    if (this.state.panel.panel === undefined) return
    this.commit({ ...this.state, panel: CLOSED.panel })
  }

  /**
   * Ask for confirmation before Delete commits.
   * @param target - what Delete would act on.
   * @param purges - whether the Host would also remove the durable log.
   */
  askDelete(target: OperationTarget, purges: boolean): void {
    this.commit({ ...this.state, confirm: { target, purges, busy: false } })
  }

  /** Mark the pending Delete as in flight. */
  markDeleting(): void {
    const confirm = this.state.confirm
    if (confirm === undefined || confirm.busy) return
    this.commit({ ...this.state, confirm: { ...confirm, busy: true } })
  }

  /** Dismiss the Delete confirmation without acting. */
  dismissDelete(): void {
    if (this.state.confirm === undefined) return
    this.commit({ ...this.state, confirm: undefined })
  }

  /**
   * Show one message.
   * @param tone - whether the message reports a failure.
   * @param text - the message.
   */
  notify(tone: NoticeState['tone'], text: string): void {
    this.commit({ ...this.state, notice: { id: this.nextNoticeId++, tone, text } })
  }

  /**
   * Dismiss one message, ignoring a request for a message that has already been replaced.
   * @param id - the notice to dismiss.
   */
  dismissNotice(id: number): void {
    if (this.state.notice?.id !== id) return
    this.commit({ ...this.state, notice: undefined })
  }

  /**
   * Withdraw everything a session owned, because that session is gone.
   * @param sessionId - the session that disappeared.
   */
  forget(sessionId: string): void {
    const panel = this.state.panel.target?.sessionId === sessionId ? CLOSED.panel : this.state.panel
    const confirm = this.state.confirm?.target.sessionId === sessionId ? undefined : this.state.confirm
    if (panel === this.state.panel && confirm === this.state.confirm) return
    this.commit({ ...this.state, panel, confirm })
  }

  /**
   * Store the dock width a resize settled on.
   *
   * Kept here as well as written to the settings section: the section is read-only on every remote
   * Web Client, and a drag that cannot be persisted must still resize the dock.
   * @param width - the width in pixels.
   */
  setDockWidth(width: number): void {
    if (this.state.dockWidth === width) return
    this.commit({ ...this.state, dockWidth: width })
  }

  /**
   * The terminal group one target holds.
   * @param key - the group key from {@link terminalKey}.
   * @returns the group; the empty group when nothing has been opened yet.
   */
  terminals(key: string): TerminalGroup {
    return this.state.terminals[key] ?? NO_TERMINALS
  }

  /**
   * Add one tab, in the state a tab has before its shell has been allocated, and show it.
   * @param key - the group key.
   * @param tabId - the caller-generated tab id, so the caller can allocate against it immediately.
   */
  addTerminal(key: string, tabId: string): void {
    const group = this.terminals(key)
    this.putTerminals(key, {
      tabs: [...group.tabs, { tabId, terminalId: undefined, shell: undefined, error: undefined }],
      activeId: tabId,
    })
  }

  /**
   * Record what a tab's allocation answered.
   * @param key - the group key.
   * @param tabId - the tab the allocation was for.
   * @param outcome - the handle and the shell, or the failure.
   */
  settleTerminal(
    key: string,
    tabId: string,
    outcome: { terminalId: string; shell: string } | { error: string },
  ): void {
    const group = this.terminals(key)
    if (!group.tabs.some(tab => tab.tabId === tabId)) return
    this.putTerminals(key, {
      ...group,
      tabs: group.tabs.map(tab => tab.tabId !== tabId
        ? tab
        : 'error' in outcome
          ? { ...tab, terminalId: undefined, shell: undefined, error: outcome.error }
          : { tabId, terminalId: outcome.terminalId, shell: outcome.shell, error: undefined }),
    })
  }

  /**
   * Show one tab's screen.
   * @param key - the group key.
   * @param tabId - the tab to show.
   */
  activateTerminal(key: string, tabId: string): void {
    const group = this.terminals(key)
    if (group.activeId === tabId || !group.tabs.some(tab => tab.tabId === tabId)) return
    this.putTerminals(key, { ...group, activeId: tabId })
  }

  /**
   * Drop one tab and show its neighbour.
   * @param key - the group key.
   * @param tabId - the tab to drop.
   * @returns the Host handle the caller must now close, when the tab had one.
   */
  removeTerminal(key: string, tabId: string): string | undefined {
    const group = this.terminals(key)
    const at = group.tabs.findIndex(tab => tab.tabId === tabId)
    if (at < 0) return undefined
    const tabs = group.tabs.filter(tab => tab.tabId !== tabId)
    // The neighbour to the left, or the new first tab: closing the last tab of a run must not leave
    // the group pointing past its own end.
    const activeId = group.activeId !== tabId
      ? group.activeId
      : tabs[Math.max(0, at - 1)]?.tabId
    this.putTerminals(key, { tabs, activeId })
    return group.tabs[at]?.terminalId
  }

  /**
   * Drop every terminal one session owns, whatever directory it had them in.
   * @param sessionId - the session.
   * @returns the Host handles the caller must now close.
   */
  dropTerminals(sessionId: string): readonly string[] {
    const prefix = `${sessionId}\u0000`
    const kept: Record<string, TerminalGroup> = {}
    const closing: string[] = []
    for (const [key, group] of Object.entries(this.state.terminals)) {
      if (!key.startsWith(prefix)) { kept[key] = group; continue }
      for (const tab of group.tabs) if (tab.terminalId !== undefined) closing.push(tab.terminalId)
    }
    if (closing.length > 0) this.commit({ ...this.state, terminals: kept })
    return closing
  }

  /**
   * Every open handle, for the teardown that must close them.
   * @returns the Host handles this browser half still holds.
   */
  allTerminals(): readonly string[] {
    return Object.values(this.state.terminals)
      .flatMap(group => group.tabs.map(tab => tab.terminalId))
      .filter((id): id is string => id !== undefined)
  }

  /** Close everything. Called from the plugin's teardown effect. */
  reset(): void {
    this.commit(CLOSED)
    this.listeners.clear()
  }

  /**
   * Replace one target's terminal group.
   * @param key - the group key.
   * @param group - the group after the change; an empty one is dropped rather than stored.
   */
  private putTerminals(key: string, group: TerminalGroup): void {
    const terminals = { ...this.state.terminals }
    if (group.tabs.length === 0) delete terminals[key]
    else terminals[key] = group
    this.commit({ ...this.state, terminals })
  }

  /**
   * Store one state and notify.
   * @param next - the committed state.
   */
  private commit(next: SidebarState): void {
    this.state = next
    // A copy, because a listener may unsubscribe from inside its own call — mutating the live set
    // mid-iteration would skip the listener that follows it.
    for (const listener of [...this.listeners]) listener()
  }
}
