/**
 * Download session log, absorbed into this plugin's menu.
 *
 * The harness ships `@deepseek-ai/dsh-session-log-export`, whose browser half does two things: it
 * provides a `sessionLogDownload` controller on the client context (`lib/client.js:263`: one
 * in-flight export per session, and a snapshot store describing it), and it registers a SECOND "⋯"
 * button into the same
 * `conversation.session.header.utilities` row this plugin's menu sits in, whose only entry is
 * "Download session log" and which also renders the progress dialog. Two identical-looking triggers
 * side by side, one of them holding a single verb, is what this module removes.
 *
 * How, and why this way (installed harness 0.1.5-rc.2):
 *
 * - The verb is REUSED, not rebuilt. The menu calls the package's own controller, read through the
 *   context service it provides, so the export request, the per-session de-duplication and the
 *   browser save stay the harness's; nothing here knows the export endpoint.
 * - The button is SHADOWED, not patched out. `…/dsh-session-log-export/lib/client.js:274-276` registers
 *   into a `list` slot with `id: 'session-log-download'` at the default priority 0, and a list slot's
 *   cell is its `id`: entries sharing one coexist at distinct priorities and the lowest live one
 *   renders (`SlotCore.register` / `entriesOfSlot` in `@deepseek-ai/dsh-client-ui-slots`). This
 *   plugin registers that same id at priority -1, so its entry takes the cell without the other
 *   package noticing, and uninstalling this plugin hands the button straight back. The rejected
 *   alternative was a profile `cordis.patch.yml` row disabling the package: that would also remove
 *   the controller the menu calls and the `/export` command's dialog, and it asks every user to edit
 *   their profile.
 * - The dialog is RE-RENDERED here. The harness's entry renders its button and its dialog as one
 *   component, and the module exports neither, so shadowing the cell takes the dialog with it. The
 *   shadowing entry therefore renders the same `Modal` from the same primitives, bound to the same
 *   store — which keeps `/export`, whose success also opens that dialog, working exactly as before.
 *
 * Everything degrades toward the harness's own behaviour rather than toward a missing verb: without
 * the package, or with a controller whose shape no longer matches, nothing is shadowed and the menu
 * has no Download entry; and the menu entry and the dialog appear only while the harness's button is
 * actually being shadowed, so a future harness that renames or removes its seat can never produce
 * two dialogs, or a verb in two places.
 * @module @achasoft/dsh-advanced-sidebar/client/log-download
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** The context service the harness package provides (`ctx.provide('sessionLogDownload', …)`). */
export const LOG_DOWNLOAD_SERVICE = 'sessionLogDownload'

/** The header slot both the harness's button and this plugin's menu occupy. */
export const LOG_DOWNLOAD_SLOT = 'conversation.session.header.utilities'

/** The list-slot cell the harness's download button occupies, and this plugin's entry shadows. */
export const LOG_DOWNLOAD_SEAT_ID = 'session-log-download'

/**
 * The shadowing rank. The harness registers at the default 0; one below is enough to render first,
 * and staying next to the default leaves room for a profile to out-rank this plugin in turn.
 */
export const LOG_DOWNLOAD_SHADOW_PRIORITY = -1

/** One session's export, as the harness controller publishes it. */
export interface LogDownloadEntry {
  /** Whether the dialog is showing; dismissing it does not cancel the export. */
  readonly open: boolean
  /** Where the export is. */
  readonly status: 'downloading' | 'success' | 'error'
  /** The failure text when `status` is `error`; null otherwise. */
  readonly error: string | null
}

/** The harness controller's store snapshot. */
export interface LogDownloadState {
  /** Export state by session id. */
  readonly bySession: Readonly<Record<string, LogDownloadEntry | undefined>>
}

/**
 * The part of `SessionLogDownloadController` this plugin calls, typed locally.
 *
 * Deliberately not imported: the package is the harness's, not a dependency of this one, and a
 * deployment composed without it must still load every other entry of the menu.
 */
export interface LogDownloadService {
  /** Snapshot store the harness's own dialog reads. */
  readonly store: HostObservable<LogDownloadState>
  /**
   * Start one session's export; a second call while one is in flight joins it.
   * @param sessionId - root session whose tree is exported.
   * @returns after the browser save starts or the failure is published.
   */
  download(sessionId: string): Promise<void>
  /**
   * Close one session's dialog without cancelling its export.
   * @param sessionId - session whose dialog closes.
   */
  dismiss(sessionId: string): void
}

/**
 * Accept a context service only when it still has the shape this plugin calls.
 *
 * The service is another package's, versioned with the harness, so its shape is checked rather than
 * trusted: an incompatible controller makes this plugin stand aside — no shadow, no menu entry —
 * which leaves the harness's own button in place instead of a menu entry that throws.
 * @param value - whatever `ctx.get('sessionLogDownload')` returned.
 * @returns the service, or undefined when absent or incompatible.
 */
export function asLogDownloadService(value: unknown): LogDownloadService | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<Record<keyof LogDownloadService, unknown>>
  const store = candidate.store as Partial<Record<keyof HostObservable<unknown>, unknown>> | null | undefined
  if (typeof candidate.download !== 'function' || typeof candidate.dismiss !== 'function') return undefined
  if (typeof store !== 'object' || store === null) return undefined
  if (typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return undefined
  return value as LogDownloadService
}

/** The registry facts {@link shadowsHarnessSeat} reads; a structural subset of a stored entry. */
export interface SeatEntryLike {
  /** The entry's registration options. */
  readonly options: { readonly id?: string | undefined; readonly priority?: number | undefined }
}

/**
 * Whether the header row holds an entry this plugin's shadow is actually hiding.
 *
 * Checked against the live registry rather than assumed, because the id is the harness's and can
 * change in an upgrade. Without an occupant to hide, the menu entry would duplicate a download
 * affordance the harness moved elsewhere, and the dialog would open twice beside the harness's own.
 * @param entries - the slot's raw entries, every priority included.
 * @returns true when some entry of the download cell ranks after (numerically above) this plugin's
 * shadow, and is therefore the one being hidden.
 */
export function shadowsHarnessSeat(entries: readonly SeatEntryLike[]): boolean {
  return entries.some(entry =>
    entry.options.id === LOG_DOWNLOAD_SEAT_ID && (entry.options.priority ?? 0) > LOG_DOWNLOAD_SHADOW_PRIORITY)
}

/** What the menu and the dialog render from. */
export interface LogDownloadView {
  /**
   * True while a compatible controller is attached AND its header button is being shadowed: the
   * one condition under which this plugin, rather than the harness, is the download surface.
   */
  readonly active: boolean
  /** The controller's per-session export state; empty while detached. */
  readonly bySession: LogDownloadState['bySession']
}

/** The detached view, shared so an unchanged snapshot keeps one identity. */
const DETACHED: LogDownloadView = { active: false, bySession: {} }

/**
 * Whether one session's export is in flight.
 * @param view - the bridge snapshot.
 * @param sessionId - the session to ask about.
 * @returns true while that session's export has not settled.
 */
export function isDownloading(view: LogDownloadView, sessionId: string): boolean {
  return view.bySession[sessionId]?.status === 'downloading'
}

/**
 * Bridges the harness controller, which may arrive late, leave, or never exist, into one observable
 * the menu can bind unconditionally.
 *
 * A `use<Name>` hook cannot be bound conditionally, and the menu is registered before the harness
 * package has necessarily loaded, so the menu binds to this instead of to the controller's store:
 * detached it reports inactive, attached it mirrors the controller's state.
 */
export class LogDownloadBridge implements HostObservable<LogDownloadView> {
  private state: LogDownloadView = DETACHED
  private readonly listeners = new Set<() => void>()
  private service: LogDownloadService | undefined
  private shadowing = false

  /**
   * The current snapshot; stable between changes, as `useSyncExternalStore` requires.
   * @returns the view.
   */
  getSnapshot(): LogDownloadView {
    return this.state
  }

  /**
   * Listen for changes.
   * @param listener - called after each change.
   * @returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Attach a controller and mirror its store until the returned disposer runs.
   * @param service - the harness controller.
   * @returns the detach, which is a no-op once another controller has replaced this one.
   */
  attach(service: LogDownloadService): () => void {
    this.service = service
    const unsubscribe = service.store.subscribe(() => { this.publish() })
    this.publish()
    return () => {
      unsubscribe()
      if (this.service !== service) return
      this.service = undefined
      this.publish()
    }
  }

  /**
   * Record whether the harness's button is currently being shadowed.
   * @param shadowing - the result of {@link shadowsHarnessSeat} over the live registry.
   */
  setShadowing(shadowing: boolean): void {
    if (this.shadowing === shadowing) return
    this.shadowing = shadowing
    this.publish()
  }

  /**
   * Start one session's export through the harness controller.
   * @param sessionId - the session to export.
   * @returns false when no controller is attached, so the caller never reports a start that did not happen.
   */
  download(sessionId: string): boolean {
    if (this.service === undefined) return false
    // The controller publishes its own failures into the dialog, so a rejection has nowhere further
    // to go; catching it only keeps it from surfacing as an unhandled rejection.
    this.service.download(sessionId).catch(() => {})
    return true
  }

  /**
   * Close one session's dialog without cancelling the export.
   * @param sessionId - the session whose dialog closes.
   */
  dismiss(sessionId: string): void {
    this.service?.dismiss(sessionId)
  }

  /** Recompute the view and notify, keeping the identity when nothing a reader sees changed. */
  private publish(): void {
    const service = this.service
    const next: LogDownloadView = service === undefined
      ? DETACHED
      : { active: this.shadowing, bySession: service.store.getSnapshot().bySession }
    if (next.active === this.state.active && next.bySession === this.state.bySession) return
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }
}
