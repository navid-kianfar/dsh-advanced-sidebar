/**
 * The one piece of state shared by this plugin's four slot registrations.
 *
 * The menu triggers, the drawer, and the confirmation dialog are separate slot entries with no
 * common React ancestor, so the panel a person opened cannot live in a component. It lives here, in
 * a `HostObservable` the registrations hand down through their inject faces' reserved `hooks`
 * compartment; the renderer binds each source into a `use<Name>` selector hook, so a component
 * re-renders for the slice it selected and nothing else.
 * @module @achasoft/dsh-advanced-sidebar/client/controller
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Which drawer is showing. */
export type PanelKind = 'changes' | 'terminal' | 'files' | 'tasks' | 'preview'

/** The session an operation acts on, resolved once at the moment the menu is opened. */
export interface OperationTarget {
  /** Session the operation acts on. */
  readonly sessionId: string
  /** Human label for dialogs and the drawer header. */
  readonly title: string
  /**
   * Absolute Host directory the panels work in: the session's own cwd, or its workspace path when
   * the session has none. Absent leaves every Host-backed entry disabled, because there is nothing
   * for git, a terminal, or a file listing to be relative to.
   */
  readonly directory: string | undefined
}

/** The open drawer, if any. */
export interface PanelState {
  /** Which drawer is showing; undefined while none is. */
  readonly panel: PanelKind | undefined
  /** What the drawer acts on. */
  readonly target: OperationTarget | undefined
}

/** A pending Delete waiting for confirmation. */
export interface ConfirmState {
  /** What Delete would act on. */
  readonly target: OperationTarget
  /** What the Host says Delete would actually do, so the dialog cannot promise a removal twice. */
  readonly purges: boolean
  /** True while the request is in flight; the dialog's buttons are disabled. */
  readonly busy: boolean
}

/** A short-lived message shown under the drawer, for outcomes that have no surface of their own. */
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
  /** The open drawer. */
  readonly panel: PanelState
  /** The pending Delete confirmation. */
  readonly confirm: ConfirmState | undefined
  /** The current notice. */
  readonly notice: NoticeState | undefined
}

/** The initial, fully closed state. Shared so an unchanged snapshot keeps one identity. */
const CLOSED: SidebarState = {
  panel: { panel: undefined, target: undefined },
  confirm: undefined,
  notice: undefined,
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
   * Show one drawer. Choosing the drawer that is already open on the same session closes it, which
   * is what makes the menu entry read as a toggle.
   * @param panel - which drawer.
   * @param target - what it acts on.
   */
  open(panel: PanelKind, target: OperationTarget): void {
    const current = this.state.panel
    const same = current.panel === panel && current.target?.sessionId === target.sessionId
    this.commit({ ...this.state, panel: same ? CLOSED.panel : { panel, target } })
  }

  /** Close the drawer. */
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

  /** Close everything. Called from the plugin's teardown effect. */
  reset(): void {
    this.commit(CLOSED)
    this.listeners.clear()
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
