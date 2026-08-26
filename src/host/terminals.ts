/**
 * Panel terminals: interactive shells this plugin owns, allocated straight from
 * `ctx.subprocess.spawnTerminal`.
 *
 * Deliberately NOT `ctx.terminals`. That registry's sessions are owner-fenced to an `Agent` and are
 * the model's working terminals; a person opening the Terminal panel is not the model, and joining
 * them would let a human's keystrokes land in a session the model believes it controls. These are
 * separate shells with the panel's own lifetime.
 *
 * There is no host-to-client push channel available to an out-of-tree plugin, so output is read by
 * offset: the browser polls, and the offset it holds is the whole-stream position it has already
 * rendered. That also makes a reconnecting panel replay exactly the retained scrollback rather than
 * an empty screen.
 * @module @achasoft/dsh-advanced-sidebar/host/terminals
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { resolveWorkspace } from './paths.ts'
import type {
  AdvancedSidebarSettings, CapabilityState, TerminalAckResult, TerminalCloseRequest,
  TerminalFailure, TerminalFailureCode, TerminalOpenRequest, TerminalOpenResult,
  TerminalReadRequest, TerminalReadResult, TerminalSignalRequest, TerminalWriteRequest,
} from './types.ts'

/** One live panel terminal and everything a later read needs. */
interface TerminalRecord {
  /** The handle the browser repeats. */
  readonly id: string
  /** The allocated terminal. */
  readonly handle: SubprocessTerminalHandle
  /** Executable that was started. */
  readonly shell: string
  /** Directory the shell started in. */
  readonly cwd: string
  /** Whole-stream character offset of the first character still retained. */
  base: number
  /** Retained scrollback. */
  buffer: string
  /** False once the shell has exited. */
  running: boolean
  /** Exit code after settlement. */
  exitCode: number | null
  /** Terminating signal after settlement. */
  signal: string | null
}

/** Compose one classified failure. */
function fail(code: TerminalFailureCode, message: string): TerminalFailure {
  return { ok: false, code, message }
}

/** Terminal geometry the substrate will accept, whatever the panel measured. */
function clampGeometry(cols: number, rows: number): { cols: number; rows: number } {
  const bound = (value: number, low: number, high: number): number =>
    Number.isFinite(value) ? Math.min(Math.max(Math.round(value), low), high) : low
  return { cols: bound(cols, 20, 500), rows: bound(rows, 5, 200) }
}

/**
 * Owns every panel terminal in the process. One instance is created by the service and disposed
 * with it, which is what guarantees no shell outlives the plugin.
 */
export class PanelTerminals {
  private readonly records = new Map<string, TerminalRecord>()
  private closing = false

  /**
   * @param ctx - Host context carrying the subprocess and filesystem capabilities.
   * @param source - reads the current settings section; called per request.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * Report whether a panel terminal can be allocated on this Host.
   * @returns availability plus the shell that would answer.
   */
  describe(): CapabilityState {
    if (this.ctx.get('subprocess') === undefined) {
      return {
        available: false,
        reason: 'no subprocess capability is mounted: this deployment composes no @deepseek-ai/dsh-subprocess provider',
      }
    }
    if (this.ctx.get('fs') === undefined) {
      return {
        available: false,
        reason: 'no filesystem capability is mounted: the terminal has no way to resolve its working directory',
      }
    }
    return { available: true, detail: this.shell() }
  }

  /**
   * Allocate one terminal in a workspace.
   * @param request - the directory and the panel's measured geometry.
   * @param signal - cancellation of the allocation; a published terminal owns its later lifetime.
   * @returns the handle, or a classified failure.
   */
  async open(request: TerminalOpenRequest, signal?: AbortSignal): Promise<TerminalOpenResult> {
    if (this.closing) return fail('closed', 'the plugin is unloading')
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) {
      return fail('no-subprocess', 'no subprocess capability is mounted')
    }
    const settings = this.source()
    // Only LIVE terminals hold a slot. An exited shell's record is kept so the panel can still read
    // its final output, and counting those would let a handful of finished commands lock the panel
    // out of starting anything.
    const live = [...this.records.values()].filter(record => record.running).length
    if (live >= settings.maxTerminals) {
      return fail('limit-reached', `${String(settings.maxTerminals)} panel terminals are already open`)
    }
    const workspace = await resolveWorkspace(this.ctx, request.workspacePath, signal)
    if (!workspace.ok) {
      return fail(
        workspace.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
        workspace.rejection.message,
      )
    }
    const shell = this.shell()
    const { cols, rows } = clampGeometry(request.cols, request.rows)
    let handle: SubprocessTerminalHandle
    try {
      handle = await subprocess.spawnTerminal({
        argv: [shell],
        cwd: workspace.value.processPath,
        rows,
        cols,
        graceMs: settings.terminalGraceMs,
        signal,
        // A real terminal, so a shell prompt and full-screen programs behave; the panel renders
        // the escape sequences it understands and passes the rest through.
        env: { TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) },
      })
    } catch (error) {
      return fail('spawn-failed', error instanceof Error ? error.message : String(error))
    }

    const record: TerminalRecord = {
      id: randomUUID(),
      handle,
      shell,
      cwd: workspace.value.processPath,
      base: 0,
      buffer: '',
      running: true,
      exitCode: null,
      signal: null,
    }
    this.records.set(record.id, record)
    this.collect(record)
    return { ok: true, terminalId: record.id, shell, cwd: record.cwd, pid: handle.pid }
  }

  /**
   * Read output from a caller-owned offset.
   * @param request - the handle and the offset already rendered.
   * @returns the delta and the process state, or a classified failure.
   */
  read(request: TerminalReadRequest): TerminalReadResult {
    const record = this.records.get(request.terminalId)
    if (record === undefined) return fail('unknown-terminal', `no panel terminal ${request.terminalId}`)
    const total = record.base + record.buffer.length
    const from = Number.isFinite(request.fromOffset) ? Math.max(0, Math.floor(request.fromOffset)) : 0
    // Behind the retained head: the gap is unrecoverable, so the whole buffer is returned and the
    // panel is told to treat it as a fresh screen rather than as a continuation.
    const lossy = from < record.base
    const text = lossy ? record.buffer : record.buffer.slice(Math.min(from - record.base, record.buffer.length))
    return {
      ok: true,
      terminalId: record.id,
      text,
      nextOffset: total,
      lossy,
      running: record.running,
      ...record.running ? {} : { exitCode: record.exitCode, signal: record.signal },
    }
  }

  /**
   * Send keystrokes.
   * @param request - the handle and the text to deliver verbatim.
   * @returns settlement, or a classified failure.
   */
  async write(request: TerminalWriteRequest): Promise<TerminalAckResult> {
    const record = this.records.get(request.terminalId)
    if (record === undefined) return fail('unknown-terminal', `no panel terminal ${request.terminalId}`)
    if (!record.running) return fail('unknown-terminal', `panel terminal ${record.id} has exited`)
    try {
      await record.handle.write(request.data)
    } catch (error) {
      return fail('spawn-failed', error instanceof Error ? error.message : String(error))
    }
    return { ok: true }
  }

  /**
   * Deliver a signal to the terminal's foreground process group.
   * @param request - the handle and the signal.
   * @returns settlement, or a classified failure.
   */
  async signal(request: TerminalSignalRequest): Promise<TerminalAckResult> {
    const record = this.records.get(request.terminalId)
    if (record === undefined) return fail('unknown-terminal', `no panel terminal ${request.terminalId}`)
    if (!record.running) return fail('unknown-terminal', `panel terminal ${record.id} has exited`)
    try {
      await record.handle.signalForeground(request.signal)
    } catch {
      // No resolvable foreground group is the ordinary answer for a shell sitting at its prompt
      // with nothing running, and a Ctrl+C there is a no-op in every terminal. Reporting it as a
      // failure would put an error line under a keystroke that did exactly what it should.
    }
    return { ok: true }
  }

  /**
   * Close one terminal and forget it.
   * @param request - the handle.
   * @returns settlement, or a classified failure.
   */
  async close(request: TerminalCloseRequest): Promise<TerminalAckResult> {
    const record = this.records.get(request.terminalId)
    if (record === undefined) return fail('unknown-terminal', `no panel terminal ${request.terminalId}`)
    this.records.delete(record.id)
    await terminateQuietly(record.handle)
    return { ok: true }
  }

  /**
   * Terminate every terminal and refuse new ones. Called from the service's teardown effect.
   * @returns after every terminal session has settled.
   */
  async disposeAll(): Promise<void> {
    this.closing = true
    const live = [...this.records.values()]
    this.records.clear()
    await Promise.all(live.map(record => terminateQuietly(record.handle)))
  }

  /**
   * The shell a new terminal starts: the configured one, then `$SHELL`, then the platform default.
   * @returns an executable name or path.
   */
  private shell(): string {
    const configured = this.source().terminalShell.trim()
    if (configured !== '') return configured
    if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe'
    const login = process.env.SHELL
    return login !== undefined && login !== '' ? login : '/bin/sh'
  }

  /**
   * Drain one terminal's output into its retained scrollback and record its settlement.
   *
   * Attached at allocation rather than at first read: a shell prints its prompt immediately, and a
   * stream nobody is reading would otherwise apply backpressure until the panel polled.
   * @param record - the freshly registered terminal.
   */
  private collect(record: TerminalRecord): void {
    // Streaming decode: a UTF-8 sequence split across two chunks would otherwise render as
    // replacement characters that never repair.
    const decoder = new TextDecoder('utf-8', { fatal: false })
    record.handle.output.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      if (text === '') return
      record.buffer += text
      const max = Math.max(this.source().terminalScrollback, 1_024)
      if (record.buffer.length > max) {
        const drop = record.buffer.length - max
        record.base += drop
        record.buffer = record.buffer.slice(drop)
      }
    })
    record.handle.done.then(
      (outcome) => {
        record.running = false
        record.exitCode = outcome.exitCode
        record.signal = outcome.signal
      },
      (error: unknown) => {
        record.running = false
        record.buffer += `\r\n[terminal transport failed: ${error instanceof Error ? error.message : String(error)}]\r\n`
      },
    )
  }
}

/**
 * Terminate one terminal session without letting a cleanup fault escape.
 * @param handle - the terminal to close.
 * @returns after the session tree has settled.
 */
async function terminateQuietly(handle: SubprocessTerminalHandle): Promise<void> {
  try {
    await handle.terminate()
  } catch {
    // Nothing can act on a failed close: the record is already gone from the map, the caller is
    // being told the terminal is closed either way, and the substrate owns whatever survived.
  }
}
