/**
 * The host↔browser channel behind the model-facing `ui_preview` tool.
 *
 * An out-of-tree plugin cannot add a wire frame, so there is no push channel from the Host to a
 * browser tab: the browser half already polls this plugin's Typert endpoints, and the tool uses that
 * same path backwards. A command is a record in a queue; the panel's driver polls for its queue,
 * executes what it finds against the frame, and posts the result back. This module owns the queue,
 * the results, and — most importantly — the deadlines, because a browser tab that is not there must
 * fail a tool call with a sentence rather than hang it until the model's turn times out.
 *
 * Three pieces of state, and each one exists for a distinct failure:
 *
 * - **A per-panel queue** of undelivered work, with a hard cap. A panel that never polls cannot make
 *   the Host hold an unbounded backlog.
 * - **The in-flight records**, keyed by command id. This is what `await`s a result.
 * - **A liveness stamp** per panel, refreshed by every poll. Without it, "the tool is waiting" and
 *   "nobody is looking at the panel" are indistinguishable, and the operator gets a timeout instead
 *   of an explanation.
 *
 * Nothing here is model-facing and nothing here is trusted: the panel that posts a result is the
 * operator's own browser, but the payload is validated by shape before it is handed to a tool.
 * @module @achasoft/dsh-advanced-sidebar/host/ui-bridge
 */

import { randomUUID } from 'node:crypto'
import type {
  PreviewBindRequest, PreviewCommand, PreviewCommandResult, PreviewConsoleEntry,
  PreviewControlMessage, PreviewMessage,
} from './types.ts'

/**
 * How many commands one panel may have queued without polling.
 *
 * A person presses one button at a time and a model issues one tool call at a time, so a backlog
 * past a handful is a panel that left; the cap is what turns that into a refusal instead of growth.
 */
const QUEUE_CAP = 32

/**
 * How many console entries are retained per panel.
 *
 * A dev server's client bundle can log per animation frame; the retained window is what a model
 * reads back, and the cursor makes the loss visible rather than silent.
 */
const CONSOLE_CAP = 1_000

/**
 * How many characters of one console line are kept. */
const CONSOLE_LINE_CAP = 8_192

/**
 * The result kind each command kind must answer with.
 *
 * A panel that answered a `dom` command with an `ack` would leave the model reading a sentence where
 * it asked for markup, and nothing else in the chain would notice. The table is what turns that into
 * a reported failure instead of a confusing one, and it is exhaustive over the command union so a
 * new kind cannot be added without deciding what it returns.
 */
const EXPECTED_RESULT: Readonly<Record<PreviewCommand['kind'], PreviewCommandResult['kind']>> = {
  open: 'ack',
  dom: 'dom',
  eval: 'eval',
  console: 'console',
  click: 'ack',
  input: 'ack',
  reload: 'ack',
  resize: 'ack',
  close: 'ack',
}

/** One panel's connection to the tool surface. */
interface Panel {
  /** Identifies this browser tab, as the tool's own audit trail and the routing key. */
  readonly clientId: string
  /** The session it serves. */
  readonly sessionId: string
  /** The last thing the panel reported about itself. */
  bind: PreviewBindRequest
  /** Epoch ms of the last poll. A panel whose stamp is too old is not there. */
  polledAt: number
  /** Commands not yet delivered. */
  readonly queue: PreviewCommand[]
  /** Console entries observed and not yet read by a `console` command. */
  readonly console: PreviewConsoleEntry[]
  /** Absolute index of the oldest retained console entry, so a cursor can be mapped. */
  consoleBase: number
  /** Absolute index one past the newest retained console entry. */
  consoleTotal: number
  /** Control messages not yet delivered. */
  readonly controls: PreviewControlMessage[]
}

/** One in-flight command, waiting for its result. */
interface InFlight {
  /** The command id, kept here so finishing one needs no reverse lookup. */
  readonly id: string
  /** What was asked, so a result of the wrong kind can be reported rather than handed on. */
  readonly kind: PreviewCommand['kind']
  /** The panel the command was sent to. */
  readonly clientId: string
  /** The session it was issued from, so a released panel can fail its work. */
  readonly sessionId: string
  /** What asked for it; only `direct` exists today, and it is here so a batch caller is expressible. */
  readonly mode: 'direct'
  /** True once a poll carried it to the panel. */
  delivered: boolean
  /** Resolves when the panel answers. */
  settle: (outcome: { ok: true; result: PreviewCommandResult } | { ok: false; error: string }) => void
  /** The deadline timer. */
  timer: ReturnType<typeof setTimeout>
}

/** Queue and liveness configuration, read from the settings section per call. */
export interface BridgeOptions {
  /** How long one command waits for its result before the tool reports a timeout. */
  readonly commandTimeoutMs: number
  /** How long a bind is trusted after its last poll. */
  readonly bindTtlMs: number
  /** Injected clock, so a test can move time without waiting for it. */
  readonly now?: () => number
}

/** Outcome of queueing a command: either an answer, or why there will not be one. */
export type QueueOutcome =
  | { readonly ok: true; readonly result: PreviewCommandResult }
  | { readonly ok: false; readonly code: 'no-surface' | 'timeout'; readonly message: string }

/**
 * The command queue, the panel registry, and the console buffer.
 *
 * Held by the Host service and disposed with it, so no timer survives an unload.
 */
export class PreviewBindings {
  private readonly panels = new Map<string, Panel>()
  /**
   * Panels that said they were done, so a later bind cannot resurrect them.
   *
   * A closed dock's queued work must fail, and "closed" is a fact only the browser knows: without
   * this, a bind request the Host never asked for would put a dead tab back on the roster and the
   * model would wait on it. A fresh mount generates a fresh client id, so a reload is unaffected.
   */
  private readonly retired = new Set<string>()
  private readonly inFlight = new Map<string, InFlight>()
  private closed = false

  /**
   * @param options - reads the current deadlines; called per operation so an edited settings
   * section reaches the next command with no registration to rebuild.
   */
  constructor(private readonly options: () => BridgeOptions) {}

  /** How many panels have polled recently enough to be considered present. */
  get livePanels(): number {
    return [...this.panels.values()].filter(panel => this.isLive(panel)).length
  }

  /**
   * Record a panel's state. Called by every poll, so it doubles as the liveness heartbeat.
   * @param bind - what the panel reported.
   * @returns the panel's id, for a caller that wants to address it later.
   */
  bind(bind: PreviewBindRequest): string {
    const existing = this.panels.get(bind.clientId)
    if (existing === undefined) {
      this.panels.set(bind.clientId, {
        clientId: bind.clientId,
        sessionId: bind.sessionId,
        bind,
        polledAt: this.now(),
        queue: [],
        console: [],
        consoleBase: 0,
        consoleTotal: 0,
        controls: [],
      })
      return bind.clientId
    }
    existing.bind = bind
    existing.polledAt = this.now()
    return bind.clientId
  }

  /**
   * Take everything queued for one panel.
   *
   * The poll is also the heartbeat, so a stale panel is refreshed even when it has no work: what the
   * tool needs to know is that the tab is alive, not that it is busy.
   * @param clientId - the panel asking.
   * @param mounted - whether a preview surface is actually rendered; false leaves the queue alone.
   * @param console - entries the panel observed since its last report.
   * @returns the work to execute and the interval after which this poll is stale.
   */
  poll(
    clientId: string, mounted: boolean, console: readonly PreviewConsoleEntry[] = [],
  ): { message: PreviewMessage; bindTtlMs: number } {
    const options = this.options()
    const panel = this.panels.get(clientId)
    if (panel === undefined) {
      return { message: { commands: [], controls: [] }, bindTtlMs: options.bindTtlMs }
    }
    panel.polledAt = this.now()
    this.appendConsole(panel, console)
    if (!mounted) {
      // A panel with no frame cannot execute anything. Its queued work is dropped and every
      // in-flight command fails now, which is the difference between "the operator closed the
      // panel" and an inexplicable timeout.
      this.dropPanelWork(panel.clientId, 'the preview panel is open but shows no preview surface')
      return { message: { commands: [], controls: [] }, bindTtlMs: options.bindTtlMs }
    }
    const commands = panel.queue.splice(0, panel.queue.length)
    for (const command of commands) {
      const record = this.inFlight.get(command.id)
      if (record !== undefined) record.delivered = true
    }
    const controls = panel.controls.splice(0, panel.controls.length)
    return { message: { commands, controls }, bindTtlMs: options.bindTtlMs }
  }

  /**
   * A panel's state, or the panel itself when it has never reported in.
   *
   * This is what lets a tool call wake a dock that has not polled yet — the operator opens the
   * Preview panel and a model asks for a DOM reading in the same second. Only the FIRST bind is
   * stored without a poll behind it: once a panel is known, its liveness rules, so a closed tab
   * cannot be resurrected by a bind request it never sent.
   * @param bind - what the panel reported.
   * @returns nothing; the caller polls afterwards.
   */
  bindAt(bind: PreviewBindRequest): void {
    if (this.panels.has(bind.clientId) || this.retired.has(bind.clientId)) return
    this.bind(bind)
  }

  /**
   * Record what one command did, and append any console lines it carried.
   *
   * A result whose command already timed out is accepted and dropped: the deadline fired, the tool
   * has its answer, and an operator's panel must not be told its report was invalid. A result of the
   * WRONG KIND is a different matter — it means the two halves disagree about the command, which is
   * a defect worth reporting rather than a late answer worth ignoring.
   * @param clientId - the panel reporting.
   * @param id - the command id.
   * @param outcome - success with a result, or the reason it failed.
   * @param console - entries the panel observed alongside the result.
   * @returns true when the id matched an in-flight command.
   */
  post(
    clientId: string,
    id: string,
    outcome: { ok: true; result: PreviewCommandResult } | { ok: false; error: string },
    console: readonly PreviewConsoleEntry[] = [],
  ): boolean {
    const panel = this.panels.get(clientId)
    if (panel !== undefined) this.appendConsole(panel, console)
    const record = this.inFlight.get(id)
    if (record === undefined) return false
    if (outcome.ok) {
      const expected = EXPECTED_RESULT[record.kind]
      if (outcome.result.kind !== expected) {
        this.finish(record, {
          ok: false,
          error: `the Preview panel answered a ${record.kind} command with a `
            + `${outcome.result.kind} result, which this Host cannot read`,
        })
        return true
      }
    }
    this.finish(record, outcome)
    return true
  }

  /**
   * Forget a panel and fail everything it was holding.
   * @param clientId - the panel that closed.
   */
  release(clientId: string): void {
    this.dropPanelWork(clientId, 'the preview panel closed before the command finished')
    if (this.panels.delete(clientId)) this.retired.add(clientId)
  }

  /**
   * Whether one panel is present and able to take a command.
   * @param clientId - the panel id, or undefined to ask about any panel in a session.
   * @param sessionId - the session the panel must belong to.
   * @returns the live panel's id, or undefined.
   */
  active(sessionId?: string, clientId?: string): string | undefined {
    const candidates = [...this.panels.values()]
      .filter(panel => this.isLive(panel))
      .filter(panel => sessionId === undefined || panel.sessionId === sessionId)
      .filter(panel => clientId === undefined || panel.clientId === clientId)
      .sort((left, right) => right.polledAt - left.polledAt)
    return candidates[0]?.clientId
  }

  /**
   * The last thing one panel reported about itself.
   * @param clientId - the panel id.
   * @returns the bind, or undefined for a panel this Host has not heard from.
   */
  bindOf(clientId: string): PreviewBindRequest | undefined {
    return this.panels.get(clientId)?.bind
  }

  /**
   * Queue one command against a live panel and wait for its answer.
   *
   * Every path out of here is bounded: a missing panel refuses immediately, a queue that is full
   * refuses immediately, and a delivered command that is never answered fails on its own deadline.
   * The one thing this must never do is wait for a browser that is not going to answer.
   * @param sessionId - the session whose panel should execute it.
   * @param command - the command body, without its id or its panel.
   * @returns the result, or the reason there is none.
   */
  async queue(
    sessionId: string,
    command: Omit<PreviewCommand, 'id' | 'clientId' | 'timeoutMs'> & { timeoutMs?: number },
  ): Promise<QueueOutcome> {
    if (this.closed) return { ok: false, code: 'no-surface', message: 'the plugin is unloading' }
    const clientId = this.active(sessionId)
    if (clientId === undefined) {
      return {
        ok: false,
        code: 'no-surface',
        message: 'no Preview panel is open in this session, so there is nothing to inspect. Open the '
          + 'Preview panel first (the session header\'s Preview entry), then call this tool again.',
      }
    }
    return this.send(clientId, command)
  }

  /**
   * Queue one command against one known panel, without requiring it to be live.
   *
   * Used by `open`, which must be able to hand a mode change to a panel before that panel has had a
   * chance to poll — the very first call against a freshly opened dock.
   * @param clientId - the panel id.
   * @param command - the command body.
   * @returns the result, or the reason there is none.
   */
  async send(
    clientId: string,
    command: Omit<PreviewCommand, 'id' | 'clientId' | 'timeoutMs'> & { timeoutMs?: number },
  ): Promise<QueueOutcome> {
    if (this.closed) return { ok: false, code: 'no-surface', message: 'the plugin is unloading' }
    const panel = this.panels.get(clientId)
    if (panel === undefined) {
      return {
        ok: false,
        code: 'no-surface',
        message: 'no Preview panel has reported in yet, so there is nothing to inspect',
      }
    }
    if (panel.queue.length >= QUEUE_CAP) {
      return {
        ok: false,
        code: 'no-surface',
        message: `the Preview panel is not keeping up: ${String(QUEUE_CAP)} commands are already `
          + 'queued and unanswered',
      }
    }
    const options = this.options()
    const timeoutMs = command.timeoutMs ?? options.commandTimeoutMs
    const id = randomUUID()
    const full: PreviewCommand = { ...command, id, clientId, timeoutMs }
    const outcome = new Promise<QueueOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const record = this.inFlight.get(id)
        if (record === undefined) return
        this.inFlight.delete(id)
        const detail = record.delivered
          ? `the Preview panel did not answer the ${command.kind} command within ${String(timeoutMs)}ms`
          : `the Preview panel has not polled for work within ${String(timeoutMs)}ms, so the `
            + `${command.kind} command was never delivered`
        resolve({ ok: false, code: 'timeout', message: detail })
      }, timeoutMs)
      // `unref` so a pending command cannot hold the process open by itself; the panel polling is
      // what keeps the Host alive in every real case.
      timer.unref?.()
      this.inFlight.set(id, {
        id,
        kind: command.kind,
        clientId,
        sessionId: panel.sessionId,
        mode: 'direct',
        delivered: false,
        timer,
        settle: (result) => { resolve(result.ok ? { ok: true, result: result.result } : { ok: false, code: 'timeout', message: result.error }) },
      })
    })
    panel.queue.push(full)
    return outcome
  }

  /**
   * Queue a mode change that needs no answer.
   * @param clientId - the panel to change.
   * @param control - what to change.
   * @returns false when the panel is unknown.
   */
  control(clientId: string, control: PreviewControlMessage): boolean {
    const panel = this.panels.get(clientId)
    if (panel === undefined) return false
    panel.controls.push(control)
    return true
  }

  /** Forget every panel and fail everything in flight. Called from the plugin's teardown. */
  dispose(): void {
    this.closed = true
    for (const clientId of [...this.panels.keys()]) this.dropPanelWork(clientId, 'the plugin is unloading')
    this.panels.clear()
    this.retired.clear()
  }

  // --- internals --------------------------------------------------------------------------------

  /**
   * One panel's liveness.
   * @param panel - the panel.
   * @returns true when its last poll is inside the trust window.
   */
  private isLive(panel: Panel): boolean {
    return this.now() - panel.polledAt <= this.options().bindTtlMs
  }

  /** The configured clock. */
  private now(): number {
    return (this.options().now ?? Date.now)()
  }

  /**
   * Append console entries to a panel's window, dropping the oldest past the cap.
   * @param panel - the panel.
   * @param entries - entries observed since the last report.
   */
  private appendConsole(panel: Panel, entries: readonly PreviewConsoleEntry[]): void {
    for (const entry of entries.slice(0, CONSOLE_CAP)) {
      panel.console.push({
        level: entry.level,
        text: entry.text.length > CONSOLE_LINE_CAP ? `${entry.text.slice(0, CONSOLE_LINE_CAP)}…` : entry.text,
        at: Number.isFinite(entry.at) ? entry.at : this.now(),
      })
      panel.consoleTotal += 1
    }
    while (panel.console.length > CONSOLE_CAP) {
      panel.console.shift()
      panel.consoleBase += 1
    }
  }

  /**
   * Fail every command one panel is holding and drop its queue.
   * @param clientId - the panel.
   * @param reason - the sentence the tool reports.
   */
  private dropPanelWork(clientId: string, reason: string): void {
    const panel = this.panels.get(clientId)
    if (panel !== undefined) {
      panel.queue.length = 0
      panel.controls.length = 0
    }
    for (const record of [...this.inFlight.values()]) {
      if (record.clientId !== clientId) continue
      this.finish(record, { ok: false, error: reason })
    }
  }

  /**
   * Resolve one in-flight command and forget it.
   * @param record - the record.
   * @param outcome - what to resolve with.
   */
  private finish(
    record: InFlight,
    outcome: { ok: true; result: PreviewCommandResult } | { ok: false; error: string },
  ): void {
    this.inFlight.delete(record.id)
    clearTimeout(record.timer)
    record.settle(outcome)
  }
}
