/**
 * Preview servers: the Host half of the Preview panel.
 *
 * A person looking at a running application needs three things the browser cannot do for itself —
 * start the process, know when its port is actually accepting, and read what it printed. This
 * module owns all three, plus the merge of where configurations come from.
 *
 * Configurations are read from the workspace's own `.claude/launch.json` first and from the
 * `previews` settings rows second, and a name declared in both is taken from the file. That order
 * is the point: a repository already carrying that file gets a working panel with nothing else to
 * write, and it stays the authority on how to run itself when a deployment also configures a row.
 *
 * Readiness is a TCP connect to the configured port, retried until it accepts or the deadline
 * passes. An HTTP probe would need a path, a method, and an opinion about which status codes count;
 * a listening socket is the one fact every dev server agrees on.
 * @module @achasoft/dsh-advanced-sidebar/host/preview
 */

import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { resolveInside, resolveWorkspace, type ResolvedPath } from './paths.ts'
import { CommandUnavailableError, resolveCommand } from './run.ts'
import type {
  AdvancedSidebarSettings, CapabilityState, PreviewFailure, PreviewFailureCode, PreviewLaunch,
  PreviewListRequest, PreviewListResult, PreviewLogsRequest, PreviewLogsResult, PreviewOrigin,
  PreviewServerView, PreviewStartRequest, PreviewStartResult, PreviewState, PreviewStopRequest,
  PreviewStopResult,
} from './types.ts'

/** Claude Code's launch file, read relative to the workspace root. */
const LAUNCH_FILE = '.claude/launch.json'

/** How long one readiness probe waits for the socket before retrying. */
const PROBE_TIMEOUT_MS = 500

/** How long to wait between readiness probes. */
const PROBE_INTERVAL_MS = 250

/** In-memory cap per collected stream, in bytes. Generous: a dev server's startup banner is small
 * and its request log is what a person scrolls back through. */
const STREAM_MAX_BYTES = 4 * 1_024 * 1_024

/** One configuration plus where it was read from. */
interface Resolved {
  /** The configuration. */
  readonly launch: PreviewLaunch
  /** Which file it came from. */
  readonly origin: PreviewOrigin
}

/** One started server and everything a later read needs. */
interface Record_ {
  /** The handle the browser repeats. */
  readonly serverId: string
  /** Configuration name, so a restarted row reuses its identity in the picker. */
  readonly name: string
  /** Canonical workspace the row belongs to. */
  readonly workspace: string
  /** Which file the configuration came from; retained so a log read reports it as truthfully as a list does. */
  readonly origin: PreviewOrigin
  /** The running process. */
  readonly handle: SubprocessHandle
  /** Where to point the frame. */
  readonly url: string | undefined
  /** Port readiness is probed on. */
  readonly port: number | undefined
  /** Epoch ms the process started. */
  readonly startedAt: number
  /** Whole-stream character offset of the first character still retained. */
  base: number
  /** Retained output, stdout and stderr interleaved in read order. */
  buffer: string
  /** Byte offsets already drained from each collected stream. */
  read: { stdout: number; stderr: number }
  /** Current lifecycle state. */
  state: PreviewState
  /** Exit code once the process has ended. */
  exitCode: number | null
  /** Why the row failed. */
  detail: string | undefined
  /** Cancels the readiness probe loop when the row stops before it settles. */
  abort: AbortController
}

/** Compose one classified failure. */
function fail(code: PreviewFailureCode, message: string): PreviewFailure {
  return { ok: false, code, message }
}

/**
 * Where a configuration's frame should point.
 * @param launch - the configuration.
 * @returns the URL, or undefined when neither a url nor a port was given.
 */
function urlOf(launch: PreviewLaunch): string | undefined {
  if (launch.url !== undefined && launch.url !== '') return launch.url
  if (launch.port === undefined || launch.port <= 0) return undefined
  // Loopback by name, not `localhost`: a host resolving `localhost` to `::1` while the server bound
  // `0.0.0.0` is the classic "it works in curl but not in the panel" failure.
  return `http://127.0.0.1:${String(launch.port)}`
}

/**
 * Whether a socket accepts a connection on one port.
 * @param port - the port to probe.
 * @param signal - cancellation of the whole readiness wait.
 * @returns true when the connection was accepted.
 */
function accepts(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const settle = (value: boolean): void => {
      socket.destroy()
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => { settle(false) }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => { settle(true) })
    socket.once('timeout', () => { settle(false) })
    socket.once('error', () => { settle(false) })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Sleep, resolving early when the wait is cancelled. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read one launch file's configurations.
 *
 * A malformed file is reported rather than thrown: the panel still lists the settings rows and says
 * why the file was ignored, which is more useful than a Preview entry that refuses to open.
 * @param text - the file's contents.
 * @returns the configurations, or the reason the file was ignored.
 */
export function parseLaunchFile(text: string): { launches: PreviewLaunch[] } | { error: string } {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof document !== 'object' || document === null) return { error: 'the top level is not an object' }
  const configurations = (document as { configurations?: unknown }).configurations
  if (!Array.isArray(configurations)) return { error: 'it carries no `configurations` array' }

  const launches: PreviewLaunch[] = []
  for (const entry of configurations) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const name = row.name
    if (typeof name !== 'string' || name === '') continue
    const args = Array.isArray(row.runtimeArgs)
      ? row.runtimeArgs.filter((value): value is string => typeof value === 'string')
      : []
    launches.push({
      name,
      ...typeof row.runtimeExecutable === 'string' && row.runtimeExecutable !== ''
        ? { runtimeExecutable: row.runtimeExecutable }
        : {},
      runtimeArgs: args,
      ...typeof row.port === 'number' && Number.isInteger(row.port) && row.port > 0
        ? { port: row.port }
        : {},
      ...typeof row.url === 'string' && row.url !== '' ? { url: row.url } : {},
      ...typeof row.cwd === 'string' && row.cwd !== '' ? { cwd: row.cwd } : {},
      ...typeof row.env === 'object' && row.env !== null
        ? {
          env: Object.fromEntries(
            Object.entries(row.env as Record<string, unknown>)
              .filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
          ),
        }
        : {},
    })
  }
  return { launches }
}

/**
 * Merge a workspace's launch file with the settings rows.
 *
 * The file wins a name collision: a repository stating how to run itself outranks a deployment-wide
 * default that happens to use the same name.
 * @param fromFile - configurations read from `.claude/launch.json`.
 * @param fromSettings - configurations from the `previews` settings rows.
 * @returns the merged list, file rows first.
 */
export function mergeLaunches(
  fromFile: readonly PreviewLaunch[], fromSettings: readonly PreviewLaunch[],
): Resolved[] {
  const merged: Resolved[] = fromFile.map(launch => ({ launch, origin: 'launch-json' as const }))
  const claimed = new Set(fromFile.map(launch => launch.name))
  for (const launch of fromSettings) {
    if (claimed.has(launch.name)) continue
    claimed.add(launch.name)
    merged.push({ launch, origin: 'settings' })
  }
  return merged
}

/**
 * Owns every preview server in the process. One instance is created by the service and disposed
 * with it, which is what guarantees no dev server outlives the plugin.
 */
export class PreviewServers {
  private readonly records = new Map<string, Record_>()
  private closing = false

  /**
   * @param ctx - Host context carrying the subprocess and filesystem capabilities.
   * @param source - reads the current settings section; called per request.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * Report whether a preview server can be started on this Host.
   * @returns availability plus how many servers are already running.
   */
  describe(): CapabilityState & { running: number } {
    const running = [...this.records.values()].filter(record => record.state !== 'exited' && record.state !== 'failed').length
    if (this.ctx.get('subprocess') === undefined) {
      return {
        available: false,
        reason: 'no subprocess capability is mounted: this deployment composes no @deepseek-ai/dsh-subprocess provider',
        running,
      }
    }
    if (this.ctx.get('fs') === undefined) {
      return {
        available: false,
        reason: 'no filesystem capability is mounted: a launch configuration has no directory to run in',
        running,
      }
    }
    return { available: true, running }
  }

  /**
   * List one workspace's configurations, each with its current state.
   * @param request - the workspace to read.
   * @param signal - cancellation for the file read.
   * @returns the list, or a classified failure.
   */
  async list(request: PreviewListRequest, signal?: AbortSignal): Promise<PreviewListResult> {
    const workspace = await resolveWorkspace(this.ctx, request.workspacePath, signal)
    if (!workspace.ok) {
      return fail(
        workspace.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
        workspace.rejection.message,
      )
    }
    const file = await this.readLaunchFile(workspace, signal)
    const merged = mergeLaunches(file.launches, this.settingsLaunches())
    return {
      ok: true,
      servers: merged.map(resolved => this.view(resolved, workspace.value.processPath)),
      ...file.path === undefined ? {} : { launchFile: file.path },
      ...file.error === undefined ? {} : { launchFileError: file.error },
    }
  }

  /**
   * Start one configuration.
   * @param request - the workspace and the configuration name.
   * @param signal - cancellation of the start itself; a started server owns its later lifetime.
   * @returns the started row, or a classified failure.
   */
  async start(request: PreviewStartRequest, signal?: AbortSignal): Promise<PreviewStartResult> {
    if (this.closing) return fail('closed', 'the plugin is unloading')
    const subprocess = this.ctx.get('subprocess')
    if (subprocess === undefined) return fail('no-subprocess', 'no subprocess capability is mounted')

    const workspace = await resolveWorkspace(this.ctx, request.workspacePath, signal)
    if (!workspace.ok) {
      return fail(
        workspace.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
        workspace.rejection.message,
      )
    }
    const file = await this.readLaunchFile(workspace, signal)
    const resolved = mergeLaunches(file.launches, this.settingsLaunches())
      .find(entry => entry.launch.name === request.name)
    if (resolved === undefined) {
      return fail('unknown-server', `no launch configuration named "${request.name}"`)
    }
    const launch = resolved.launch
    if (launch.runtimeExecutable === undefined || launch.runtimeExecutable === '') {
      return fail('not-startable', `"${launch.name}" names no command; it opens its url and starts nothing`)
    }

    const settings = this.source()
    const live = [...this.records.values()].filter(record => record.state === 'starting' || record.state === 'ready')
    if (live.length >= settings.maxPreviews) {
      return fail('limit-reached', `${String(settings.maxPreviews)} preview servers are already running`)
    }
    // Restarting a row replaces its predecessor rather than running two servers on one port.
    const previous = this.find(workspace.value.processPath, launch.name)
    if (previous !== undefined) await this.terminate(previous)

    const directory = await this.launchDirectory(workspace, launch, signal)
    if ('failure' in directory) return directory.failure

    let executable: string | undefined
    try {
      executable = await resolveCommand(this.ctx, launch.runtimeExecutable, signal)
    } catch (error) {
      return fail('no-subprocess', error instanceof CommandUnavailableError ? error.message : String(error))
    }
    if (executable === undefined) {
      return fail('unavailable', `"${launch.runtimeExecutable}" does not resolve on this Host`)
    }

    let handle: SubprocessHandle
    try {
      handle = subprocess.spawn({
        argv: [executable, ...launch.runtimeArgs ?? []],
        cwd: directory.path,
        stdio: {
          // A dev server that waits on stdin would hang with no way to answer it from here.
          stdin: 'ignore',
          stdout: { maxBytes: STREAM_MAX_BYTES },
          stderr: { maxBytes: STREAM_MAX_BYTES },
        },
        graceMs: settings.previewGraceMs,
        env: {
          // Colour codes would reach the log view as escape sequences nothing renders, and every
          // toolchain honours one of these two.
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          ...launch.env ?? {},
          ...launch.port === undefined ? {} : { PORT: String(launch.port) },
        },
      })
    } catch (error) {
      return fail('spawn-failed', error instanceof Error ? error.message : String(error))
    }

    const record: Record_ = {
      serverId: randomUUID(),
      name: launch.name,
      workspace: workspace.value.processPath,
      origin: resolved.origin,
      handle,
      url: urlOf(launch),
      port: launch.port,
      startedAt: Date.now(),
      base: 0,
      buffer: '',
      read: { stdout: 0, stderr: 0 },
      // A row with no port has nothing to probe, so it is ready as soon as it is running.
      state: launch.port === undefined ? 'ready' : 'starting',
      exitCode: null,
      detail: undefined,
      abort: new AbortController(),
    }
    this.records.set(record.serverId, record)
    this.watch(record)
    if (record.state === 'starting') void this.awaitReady(record)
    return { ok: true, server: this.viewOf(record) }
  }

  /**
   * Stop one server and forget it.
   * @param request - the handle.
   * @returns settlement, or a classified failure.
   */
  async stop(request: PreviewStopRequest): Promise<PreviewStopResult> {
    const record = this.records.get(request.serverId)
    if (record === undefined) return fail('unknown-server', `no preview server ${request.serverId}`)
    this.records.delete(record.serverId)
    await this.terminate(record)
    return { ok: true }
  }

  /**
   * Read one server's output from a caller-owned offset, with its state at read time.
   * @param request - the handle and the offset already rendered.
   * @returns the delta and the state, or a classified failure.
   */
  logs(request: PreviewLogsRequest): PreviewLogsResult {
    const record = this.records.get(request.serverId)
    if (record === undefined) return fail('unknown-server', `no preview server ${request.serverId}`)
    this.drain(record)
    const total = record.base + record.buffer.length
    const from = Number.isFinite(request.fromOffset) ? Math.max(0, Math.floor(request.fromOffset)) : 0
    const lossy = from < record.base
    const text = lossy ? record.buffer : record.buffer.slice(Math.min(from - record.base, record.buffer.length))
    return {
      ok: true,
      serverId: record.serverId,
      text,
      nextOffset: total,
      lossy,
      server: this.viewOf(record),
    }
  }

  /**
   * Terminate every server and refuse new ones. Called from the service's teardown effect.
   * @returns after every process tree has exited.
   */
  async disposeAll(): Promise<void> {
    this.closing = true
    const live = [...this.records.values()]
    this.records.clear()
    await Promise.all(live.map(record => this.terminate(record)))
  }

  /**
   * The `previews` settings rows, normalized into the shape the merge reads.
   * @returns the configured launches.
   */
  private settingsLaunches(): PreviewLaunch[] {
    return this.source().previews.map(row => ({
      name: row.name,
      ...row.runtimeExecutable === '' ? {} : { runtimeExecutable: row.runtimeExecutable },
      runtimeArgs: row.runtimeArgs,
      ...row.port <= 0 ? {} : { port: row.port },
      ...row.url === '' ? {} : { url: row.url },
      ...row.cwd === '' ? {} : { cwd: row.cwd },
    }))
  }

  /**
   * Read and parse the workspace's launch file.
   * @param workspace - the resolved workspace.
   * @param signal - cancellation for the read.
   * @returns the configurations, the file's path when it existed, and why it was ignored when it was.
   */
  private async readLaunchFile(
    workspace: Extract<Awaited<ReturnType<typeof resolveWorkspace>>, { ok: true }>,
    signal?: AbortSignal,
  ): Promise<{ launches: PreviewLaunch[]; path?: string; error?: string }> {
    if (!this.source().previewsFromLaunchFile) return { launches: [] }
    const fs = this.ctx.get('fs')
    if (fs === undefined) return { launches: [] }
    const path = join(workspace.value.processPath, LAUNCH_FILE)
    let text: string
    try {
      const target = await fs.resolve(path, signal === undefined ? {} : { signal })
      const info = await fs.stat(target, signal)
      // No launch file is the ordinary case, not a fault: most workspaces have none.
      if (info === undefined || info.type !== 'file') return { launches: [] }
      text = await fs.readText(target, signal)
    } catch {
      return { launches: [] }
    }
    const parsed = parseLaunchFile(text)
    if ('error' in parsed) return { launches: [], path, error: `${LAUNCH_FILE} was ignored: ${parsed.error}` }
    return { launches: parsed.launches, path }
  }

  /**
   * Resolve the directory one configuration runs in, proving it stays inside the workspace.
   * @param workspace - the resolved workspace.
   * @param launch - the configuration.
   * @param signal - cancellation for the resolution.
   * @returns the directory, or the failure to return.
   */
  private async launchDirectory(
    workspace: Extract<Awaited<ReturnType<typeof resolveWorkspace>>, { ok: true }>,
    launch: PreviewLaunch,
    signal?: AbortSignal,
  ): Promise<{ path: string } | { failure: PreviewFailure }> {
    if (launch.cwd === undefined || launch.cwd === '') return { path: workspace.value.processPath }
    const candidate = isAbsolute(launch.cwd) ? launch.cwd : join(workspace.value.processPath, launch.cwd)
    const resolved = await resolveInside(this.ctx, workspace.value as ResolvedPath, candidate, signal)
    if (!resolved.ok) {
      return {
        failure: fail(
          resolved.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
          resolved.rejection.message,
        ),
      }
    }
    return { path: resolved.value.processPath }
  }

  /**
   * Watch one process for its exit.
   * @param record - the started server.
   */
  private watch(record: Record_): void {
    record.handle.done.then(
      (outcome) => {
        record.abort.abort()
        record.exitCode = outcome.exitCode
        // A server that never reached `ready` and then exited is a failed launch; one that was
        // serving and then stopped is simply over, and its logs are still worth reading.
        record.state = record.state === 'ready' ? 'exited' : 'failed'
        if (record.state === 'failed' && record.detail === undefined) {
          record.detail = outcome.signal === null
            ? `the process exited with code ${String(outcome.exitCode)} before its port accepted`
            : `the process ended on ${outcome.signal} before its port accepted`
        }
      },
      (error: unknown) => {
        record.abort.abort()
        record.state = 'failed'
        record.detail = error instanceof Error ? error.message : String(error)
      },
    )
  }

  /**
   * Probe one server's port until it accepts or the deadline passes.
   * @param record - the started server.
   */
  private async awaitReady(record: Record_): Promise<void> {
    const port = record.port
    /* v8 ignore next -- only a row WITH a port enters the starting state. */
    if (port === undefined) return
    const deadline = Date.now() + this.source().previewReadyTimeoutMs
    while (!record.abort.signal.aborted && Date.now() < deadline) {
      if (await accepts(port, record.abort.signal)) {
        if (record.state === 'starting') record.state = 'ready'
        return
      }
      await pause(PROBE_INTERVAL_MS, record.abort.signal)
    }
    if (record.state === 'starting') {
      record.state = 'failed'
      record.detail = `port ${String(port)} did not accept a connection within previewReadyTimeoutMs`
    }
  }

  /**
   * Move whatever the collected streams hold into the retained buffer.
   *
   * Both streams share one buffer and one offset, because the panel shows one log: a dev server
   * prints its banner on one and its errors on the other, and two independently scrolling views of
   * the same startup would be harder to read, not easier.
   * @param record - the server to drain.
   */
  private drain(record: Record_): void {
    const take = (reader: SubprocessOutputReader | undefined, from: number): { text: string; next: number } => {
      /* v8 ignore next -- both streams are spawned in collect mode, so both readers exist. */
      if (reader === undefined) return { text: '', next: from }
      const read = reader.readFrom(from)
      return { text: read.text, next: read.nextOffset }
    }
    const out = take(record.handle.collected.stdout, record.read.stdout)
    const err = take(record.handle.collected.stderr, record.read.stderr)
    record.read = { stdout: out.next, stderr: err.next }
    const added = out.text + err.text
    if (added === '') return
    record.buffer += added
    const max = Math.max(this.source().previewScrollback, 1_024)
    if (record.buffer.length > max) {
      const drop = record.buffer.length - max
      record.base += drop
      record.buffer = record.buffer.slice(drop)
    }
  }

  /**
   * Find a live record for one workspace and configuration name.
   * @param workspace - canonical workspace path.
   * @param name - configuration name.
   * @returns the record, when one exists.
   */
  private find(workspace: string, name: string): Record_ | undefined {
    for (const record of this.records.values()) {
      if (record.workspace === workspace && record.name === name) return record
    }
    return undefined
  }

  /**
   * Stop one process tree without letting a cleanup fault escape.
   * @param record - the server to stop.
   * @returns after the tree has exited.
   */
  private async terminate(record: Record_): Promise<void> {
    record.abort.abort()
    this.records.delete(record.serverId)
    try {
      record.handle.terminate()
      await record.handle.waitForExit()
    } catch {
      // Nothing can act on a failed stop: the record is already gone from the map, the caller is
      // being told the server is stopped either way, and the substrate owns whatever survived.
    }
  }

  /**
   * Project one configuration into its view, attaching a live record when one exists.
   * @param resolved - the configuration and its origin.
   * @param workspace - canonical workspace path.
   * @returns the view.
   */
  private view(resolved: Resolved, workspace: string): PreviewServerView {
    const record = this.find(workspace, resolved.launch.name)
    if (record !== undefined) return this.viewOf(record)
    const startable = resolved.launch.runtimeExecutable !== undefined && resolved.launch.runtimeExecutable !== ''
    const url = urlOf(resolved.launch)
    return {
      name: resolved.launch.name,
      origin: resolved.origin,
      startable,
      // A row with no command is not "stopped" waiting to be started — it is a bookmark, and the
      // panel opens it straight away.
      state: startable ? 'stopped' : 'ready',
      ...url === undefined ? {} : { url },
      ...resolved.launch.port === undefined ? {} : { port: resolved.launch.port },
      ...startable ? {} : { detail: 'this configuration opens its url and starts nothing' },
    }
  }

  /**
   * Project one live record into its view.
   * @param record - the server.
   * @returns the view.
   */
  private viewOf(record: Record_): PreviewServerView {
    return {
      serverId: record.serverId,
      name: record.name,
      origin: record.origin,
      startable: true,
      state: record.state,
      ...record.url === undefined ? {} : { url: record.url },
      ...record.port === undefined ? {} : { port: record.port },
      ...record.handle.pid < 0 ? {} : { pid: record.handle.pid },
      ...record.state === 'exited' || record.state === 'failed' ? { exitCode: record.exitCode } : {},
      ...record.detail === undefined ? {} : { detail: record.detail },
      startedAt: record.startedAt,
    }
  }
}
