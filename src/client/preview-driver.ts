/**
 * The panel's end of the agent channel: poll for work, execute it against the frame, report back.
 *
 * There is no host-to-browser push in an out-of-tree plugin, so the direction is inverted — the
 * panel asks the Host whether the agent wants anything, and answers with what it found. This module
 * owns that loop, the frame-side execution, and the console capture the agent reads through.
 *
 * Three rules shape everything here:
 *
 * 1. **Only same-origin frames can be inspected.** A page framed from another origin has no
 *    reachable `document`, and `contentDocument === null` is the only reliable test for it. Every
 *    read and every write refuses such a frame by name, so the model gets "this page is
 *    cross-origin" instead of a timeout or an empty DOM.
 * 2. **The agent's window into the frame is bounded.** The DOM walk stops at a node count and a
 *    text length, the eval result is serialized with a cycle-safe replacer under a character cap,
 *    and the console buffer is a ring. A page that logs per animation frame cannot flood a model's
 *    context through this tool.
 * 3. **Nothing here throws across the boundary.** A command that a page rejects — a missing
 *    selector, an expression that throws, a frame that navigated mid-command — comes back as a
 *    readable sentence, because a rejected promise at this layer would be an unexplained tool
 *    timeout.
 * @module @achasoft/dsh-advanced-sidebar/client/preview-driver
 */

import type {
  PreviewCommand, PreviewCommandResult, PreviewConsoleEntry, PreviewControlMessage, PreviewDomNode,
} from '../host/types.ts'
import type { PreviewFace } from './preview-types.ts'
import { EVAL_CAP, describeValue, safeJson } from './preview-values.ts'

/** How often the panel asks for work while a preview is mounted. */
const POLL_MS = 600

/** How often it asks while the panel is open but nothing is framed. */
const IDLE_POLL_MS = 2_000

/** Largest number of elements one `dom` walk returns. */
const DOM_NODE_CAP = 400

/** Largest text length one node's own text, or the root's `innerText`, contributes. */
const TEXT_CAP = 400

/** Console entries retained in the browser before the oldest are dropped. */
const CONSOLE_CAP = 500

/** Characters retained from one console line. */
const CONSOLE_LINE_CAP = 4_000

/** One captured console entry, in the browser's own shape. */
interface Captured {
  /** Level or source. */
  readonly level: PreviewConsoleEntry['level']
  /** The joined arguments. */
  readonly text: string
  /** Epoch ms. */
  readonly at: number
}

/**
 * The marker that proves the console has already been wrapped.
 *
 * A document that is navigated or reloaded gets a fresh window with no wrapper, so the check runs on
 * every poll and re-installs on the frame that replaced it. The wrapper is written with
 * `Object.defineProperty` over the original methods and keeps the originals in a closure, so a page
 * that reads `console.log.name` still sees a native function.
 */
const HOOK_KEY = '__dshAdvancedSidebarConsole'

/** The frame as this driver needs to see it. */
export interface FrameView {
  /** The iframe element, or null while none is mounted. */
  readonly element: HTMLIFrameElement | null
  /**
   * The frame's document, or null when it is cross-origin or not loaded yet.
   *
   * Read from the element each time rather than cached: a navigation replaces the document, and a
   * cached reference to the old one would answer about the page the operator just left.
   */
  readonly document: Document | null
  /** The frame's window, or null when it is cross-origin or not loaded yet. */
  readonly window: Window | null
}

/**
 * What the driver needs from the panel around it.
 *
 * Callbacks rather than a React reference: the loop runs outside the render cycle, and a panel that
 * re-rendered on every tick would re-run its own effects at poll cadence.
 */
export interface DriverHooks {
  /** Read the frame as it is right now. */
  frame: () => FrameView
  /** Apply a mode change the agent asked for. */
  control: (message: PreviewControlMessage) => void
  /** Force the frame to remount and reload. */
  reload: () => void
  /** Apply a viewport the agent asked for. */
  resize: (width: number, height: number) => void
}

/**
 * The polling driver. One instance per mounted panel; `stop()` releases it.
 */
export class PreviewDriver {
  /** Console entries captured since the last report, oldest first. */
  private readonly buffer: Captured[] = []

  /** Commands currently executing, so a poll that overlaps the previous one does not double-run. */
  private readonly running = new Set<string>()

  private timer = 0

  private stopped = true

  /**
   * @param face - the Remote face the panel was handed.
   * @param clientId - this browser tab's identity, generated once per panel mount.
   * @param sessionId - the session the panel serves.
   * @param hooks - how to read and act on the frame.
   */
  constructor(
    private readonly face: PreviewFace,
    private readonly clientId: string,
    private readonly sessionId: string,
    private readonly hooks: DriverHooks,
  ) {}

  /**
   * Start polling. Idempotent, so a re-render may call it again freely.
   * @param bind - the panel's current state, refreshed on every poll.
   */
  start(bind: () => {
    mounted: boolean
    mode: 'server' | 'file' | 'url' | 'scratchpad'
    filePath?: string | undefined
    workspacePath?: string | undefined
    url?: string | undefined
    inspectable: boolean
    width: number
    height: number
  }): void {
    if (!this.stopped) return
    this.stopped = false
    const tick = async (): Promise<void> => {
      if (this.stopped) return
      let cadence = this.buffer.length > 0 || this.running.size > 0 ? POLL_MS : IDLE_POLL_MS
      try {
        const state = bind()
        this.captureConsole()
        const answer = await this.face.previewPoll({
          clientId: this.clientId,
          sessionId: this.sessionId,
          mounted: state.mounted,
          bind: {
            clientId: this.clientId,
            sessionId: this.sessionId,
            mode: state.mode,
            ...state.filePath === undefined ? {} : { filePath: state.filePath },
            ...state.workspacePath === undefined ? {} : { workspacePath: state.workspacePath },
            ...state.url === undefined ? {} : { url: state.url },
            inspectable: state.inspectable,
            width: state.width,
            height: state.height,
          },
        })
        if (!answer.ok) {
          // A closed or headless Host has nothing to give this panel; it keeps polling at the slow
          // cadence so a reconnected Host is picked up without a reload.
          cadence = IDLE_POLL_MS
        } else {
          for (const control of answer.message.controls) this.hooks.control(control)
          if (answer.message.commands.length > 0) cadence = POLL_MS
          for (const command of answer.message.commands) void this.execute(command)
        }
      } catch {
        // A transport failure is the panel's own problem to display, not a reason to stop the loop:
        // the next poll either succeeds or reports its own failure.
        cadence = IDLE_POLL_MS
      }
      if (!this.stopped) this.timer = window.setTimeout(() => { void tick() }, cadence)
    }
    void tick()
  }

  /** Stop polling. Called when the panel unmounts. */
  stop(): void {
    this.stopped = true
    window.clearTimeout(this.timer)
    this.timer = 0
  }

  /**
   * Execute one command and report what it did.
   * @param command - the command.
   */
  private async execute(command: PreviewCommand): Promise<void> {
    if (this.running.has(command.id)) return
    this.running.add(command.id)
    let outcome: { ok: true; result: PreviewCommandResult } | { ok: false; error: string }
    try {
      outcome = await this.run(command)
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    this.running.delete(command.id)
    // Console lines the command itself produced are reported with it, so a `click` that logs comes
    // back with the log rather than making the model poll again.
    const console_ = this.drain()
    try {
      await this.face.previewResult({
        clientId: this.clientId,
        id: command.id,
        ok: outcome.ok,
        ...outcome.ok ? { result: outcome.result } : { error: outcome.error },
        ...console_.length === 0 ? {} : { console: console_ },
      })
    } catch {
      // The Host already failed this command on its own deadline; a report that cannot be delivered
      // is dropped rather than retried, because a stale result has no reader.
    }
  }

  /**
   * Run one command against the frame.
   * @param command - the command.
   * @returns the result, or the sentence explaining the refusal.
   */
  private async run(
    command: PreviewCommand,
  ): Promise<{ ok: true; result: PreviewCommandResult } | { ok: false; error: string }> {
    if (command.kind === 'open') {
      // The mode change arrived as a control message; the command is the agent's handshake that it
      // is waiting for the panel to acknowledge the surface is there.
      const frame = this.hooks.frame()
      return {
        ok: true,
        result: {
          kind: 'ack',
          detail: frame.element === null
            ? 'the Preview panel is open and has taken the request'
            : `the Preview panel is loading ${frame.element.src === '' ? 'the requested document' : shortUrl(frame.element.src)}`,
        },
      }
    }
    if (command.kind === 'reload') {
      this.hooks.reload()
      return { ok: true, result: { kind: 'ack', detail: 'the frame was reloaded' } }
    }
    if (command.kind === 'resize') {
      const width = command.width ?? 0
      const height = command.height ?? 0
      this.hooks.resize(width, height)
      return { ok: true, result: { kind: 'ack', detail: `the frame viewport is now ${String(width)}×${String(height)}`, width, height } }
    }
    if (command.kind === 'close') {
      return { ok: true, result: { kind: 'ack', detail: 'the preview was closed' } }
    }
    if (command.kind === 'console') {
      const drained = this.drain()
      const cursor = command.cursor ?? 0
      const entries = drained.map(entry => ({ level: entry.level, text: entry.text, at: entry.at }))
      return { ok: true, result: { kind: 'console', entries, cursor: cursor + entries.length, lossy: false } }
    }

    const frame = this.hooks.frame()
    if (frame.element === null) {
      return { ok: false, error: 'no preview is mounted in the panel, so there is nothing to inspect' }
    }
    if (frame.document === null || frame.window === null) {
      return {
        ok: false,
        error: 'the framed page is not same-origin with this GUI, so its document cannot be read. '
          + 'Open a loopback URL (the Host proxies it) or a workspace file to make it inspectable.',
      }
    }

    switch (command.kind) {
      case 'dom': return { ok: true, result: readDom(frame, command.selector ?? '') }
      case 'eval': return { ok: true, result: evaluate(frame, command.expression ?? '') }
      case 'click': return click(frame, command.selector ?? '')
      case 'input': return input(frame, command)
      /* v8 ignore next 2 -- the command union is exhaustive above. */
      default: return { ok: false, error: `the panel does not know how to ${String(command.kind)}` }
    }
  }

  /**
   * Take everything captured since the last drain.
   * @returns the entries, oldest first.
   */
  private drain(): Captured[] {
    return this.buffer.splice(0, this.buffer.length)
  }

  /**
   * Wrap the frame's console, once per document.
   *
   * Called from the poll rather than from a load listener because a navigation can complete between
   * two polls, and the check is one property read on the frame's own window.
   */
  private captureConsole(): void {
    const frame = this.hooks.frame()
    const win = frame.window
    if (win === null) return
    // `Window` in the DOM lib carries no `console` or `eval` member: both live on the global object
    // this window IS at runtime, so the frame's own window is read through a plain record and the
    // properties are looked up the way the page itself would find them.
    const globals = win as unknown as Record<string, unknown>
    const carrier = globals
    if (carrier[HOOK_KEY] !== undefined) return
    const record = (level: PreviewConsoleEntry['level'], parts: readonly unknown[]): void => {
      this.push({ level, text: parts.map(describeValue).join(' '), at: Date.now() })
    }
    try {
      carrier[HOOK_KEY] = true
      const target = globals.console as Console
      const original = {
        log: target.log.bind(target),
        info: target.info.bind(target),
        warn: target.warn.bind(target),
        error: target.error.bind(target),
      }
      for (const level of ['log', 'info', 'warn', 'error'] as const) {
        Object.defineProperty(target, level, {
          configurable: true,
          writable: true,
          value: (...parts: unknown[]) => {
            record(level, parts)
            original[level](...parts)
          },
        })
      }
      win.addEventListener('error', (event: ErrorEvent) => {
        const where = event.filename === '' ? '' : ` (${event.filename}:${String(event.lineno)})`
        record('uncaught', [`${event.message}${where}`])
      })
      win.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        record('rejection', [describeValue(event.reason)])
      })
    } catch {
      // A window that refuses the write (a sandboxed one, say) simply has no captured console; the
      // panel still shows the DOM and the events, which is the part that matters.
    }
  }

  /**
   * Append one captured entry, dropping the oldest past the ring.
   * @param entry - the entry.
   */
  private push(entry: Captured): void {
    this.buffer.push({
      level: entry.level,
      text: entry.text.length > CONSOLE_LINE_CAP ? `${entry.text.slice(0, CONSOLE_LINE_CAP)}…` : entry.text,
      at: entry.at,
    })
    while (this.buffer.length > CONSOLE_CAP) this.buffer.shift()
  }
}

/**
 * A short display form of a URL, for one-line answers.
 * @param value - the URL.
 * @returns the pathname and search, or the value when it is not a URL.
 */
function shortUrl(value: string): string {
  try {
    const url = new URL(value, window.location.origin)
    return `${url.pathname}${url.search}`
  } catch {
    return value
  }
}

/**
 * Read the rendered DOM under one selector.
 * @param frame - the frame.
 * @param selector - a CSS selector, or the empty string for the document element.
 * @returns the reading.
 */
function readDom(frame: FrameView, selector: string): PreviewDomResultShape {
  const doc = frame.document
  const win = frame.window
  /* v8 ignore next -- `run` refuses a null document before this is called. */
  if (doc === null || win === null) throw new Error('the frame has no readable document')
  const root = selector === '' ? doc.documentElement : doc.querySelector(selector)
  if (root === null) {
    throw new Error(`no element matches ${JSON.stringify(selector)} in the framed document`)
  }
  const nodes: PreviewDomNode[] = []
  let truncated = false
  const walk = (element: Element, depth: number): void => {
    if (nodes.length >= DOM_NODE_CAP) { truncated = true; return }
    const style = win.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const own = [...element.childNodes]
      .filter((node): node is Text => node.nodeType === 3)
      .map(node => node.textContent ?? '')
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim()
    nodes.push({
      tag: element.tagName.toLowerCase(),
      selector: selectorFragment(element),
      text: own.slice(0, TEXT_CAP),
      display: style.display,
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      depth,
    })
    for (const child of element.children) walk(child, depth + 1)
  }
  walk(root, 0)
  const inner = (root as HTMLElement).innerText ?? root.textContent ?? ''
  return {
    kind: 'dom',
    selector,
    viewport: { width: win.innerWidth, height: win.innerHeight },
    nodes,
    text: inner.replace(/\s+/gu, ' ').trim().slice(0, TEXT_CAP * 4),
    truncated,
    url: doc.location.href,
  }
}

/** The shape `readDom` returns; named so the walker's return type is not inferred from itself. */
type PreviewDomResultShape = Extract<PreviewCommandResult, { kind: 'dom' }>

/**
 * A short, readable selector fragment for one element.
 * @param element - the element.
 * @returns `#id.class.class`, or the empty string when the element has neither.
 */
function selectorFragment(element: Element): string {
  const id = element.id === '' ? '' : `#${element.id}`
  const classes = typeof element.className === 'string' && element.className.trim() !== ''
    ? `.${element.className.trim().split(/\s+/u).slice(0, 3).join('.')}`
    : ''
  return `${id}${classes}`.slice(0, 120)
}

/**
 * Evaluate one expression inside the frame and serialize its value.
 * @param frame - the frame.
 * @param expression - the source.
 * @returns the value as JSON text, with a note when JSON could not represent it.
 */
function evaluate(frame: FrameView, expression: string): PreviewEvalResultShape {
  const win = frame.window
  /* v8 ignore next -- `run` refuses a null window before this is called. */
  if (win === null) throw new Error('the frame has no readable window')
  const source = expression.trim()
  if (source === '') throw new Error('the expression is empty')
  // The frame's own `Function` constructor, so the compiled code belongs to the framed page's realm
  // and sees the page's globals rather than this driver's. A direct `eval` here would run in the
  // DRIVER's lexical scope — this function's — which is the parent window's, and the model would be
  // reading the wrong document.
  //
  // `Window` carries no `Function` member in the DOM lib; the global object this window IS has one,
  // so the constructor is read off the window through a record and given the one signature used.
  const construct = (win as unknown as Record<string, unknown>).Function as
    | (new (code: string) => () => unknown)
    | undefined
  if (construct === undefined) throw new Error('the framed page has no Function constructor to evaluate with')
  const evaluate = (code: string): unknown => new construct(code)()
  // An expression is tried first, because `1 + 1` and `document.title` are what a model writes; a
  // statement list is the fallback, so `const x = 1; x + 1` still works. Both are wrapped so that a
  // completion value comes back out.
  let value: unknown
  try {
    value = evaluate(`return (${source})`)
  } catch (error) {
    if (error instanceof SyntaxError) {
      value = evaluate(source)
    } else {
      throw new Error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    }
  }
  const json = safeJson(value)
  const text = json.text.length > EVAL_CAP ? `${json.text.slice(0, EVAL_CAP)}…` : json.text
  return {
    kind: 'eval',
    value: text,
    ...json.note === undefined ? {} : { note: json.note },
    truncated: json.text.length > EVAL_CAP,
  }
}

/** The shape `evaluate` returns. */
type PreviewEvalResultShape = Extract<PreviewCommandResult, { kind: 'eval' }>

/**
 * Dispatch a real click on one element.
 * @param frame - the frame.
 * @param selector - the CSS selector.
 * @returns the acknowledgement, or the refusal.
 */
function click(
  frame: FrameView, selector: string,
): { ok: true; result: PreviewCommandResult } | { ok: false; error: string } {
  const doc = frame.document
  /* v8 ignore next -- `run` refuses a null document before this is called. */
  if (doc === null) return { ok: false, error: 'the frame has no readable document' }
  if (selector === '') return { ok: false, error: 'a click needs a CSS selector' }
  const element = doc.querySelector(selector)
  if (element === null) return { ok: false, error: `no element matches ${JSON.stringify(selector)}` }
  if (!(element instanceof HTMLElement)) {
    return { ok: false, error: `${JSON.stringify(selector)} is not an element this can click` }
  }
  // A real `click()` rather than a synthesized `MouseEvent`: it runs the element's own activation
  // behaviour (a link navigates, a submit button submits, a label forwards to its control), which
  // a hand-built event does not.
  element.click()
  return {
    ok: true,
    result: { kind: 'ack', detail: `clicked ${selectorFragment(element) === '' ? element.tagName.toLowerCase() : selectorFragment(element)}` },
  }
}

/**
 * Set one field's value and dispatch the events a person's typing would.
 * @param frame - the frame.
 * @param command - the command carrying the selector, the text, and an optional key.
 * @returns the acknowledgement, or the refusal.
 */
function input(
  frame: FrameView, command: PreviewCommand,
): { ok: true; result: PreviewCommandResult } | { ok: false; error: string } {
  const doc = frame.document
  /* v8 ignore next -- `run` refuses a null document before this is called. */
  if (doc === null) return { ok: false, error: 'the frame has no readable document' }
  const selector = command.selector ?? ''
  if (selector === '') return { ok: false, error: 'typing needs a CSS selector' }
  const element = doc.querySelector(selector)
  if (element === null) return { ok: false, error: `no element matches ${JSON.stringify(selector)}` }
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return {
      ok: false,
      error: `${JSON.stringify(selector)} is a <${element.tagName.toLowerCase()}>, which has no value to set`,
    }
  }
  const text = command.text ?? ''
  // The native setter is used rather than `element.value = text` because a framework (React, Vue)
  // installs its own value property and ignores a direct write; assigning through the prototype's
  // setter is what makes the framework's change detection see it.
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) element.value = text
  else setter.call(element, text)
  // Both events, in this order: `input` is what a live-bound framework listens to, `change` is what
  // a plain form listens to, and a tool that fired only one would appear to work half the time.
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  if (command.key !== undefined && command.key !== '') {
    const init = { key: command.key, code: command.key, bubbles: true, cancelable: true }
    element.dispatchEvent(new KeyboardEvent('keydown', init))
    element.dispatchEvent(new KeyboardEvent('keyup', init))
    if (command.key === 'Enter' && element instanceof HTMLInputElement) {
      // A form's own submit is what an Enter in a field does; a `KeyboardEvent` alone never
      // triggers it, and a model typing Enter expects the search to run.
      element.form?.requestSubmit()
    }
  }
  return {
    ok: true,
    result: {
      kind: 'ack',
      detail: `set ${selectorFragment(element) === '' ? element.tagName.toLowerCase() : selectorFragment(element)} `
        + `to ${JSON.stringify(text)}${command.key === undefined ? '' : ` and pressed ${command.key}`}`,
    },
  }
}
