/**
 * The advanced-sidebar plugin's node half: one Remote namespace serving every operation the browser
 * structurally cannot perform, plus the `advanced-sidebar` settings section both halves address.
 *
 * What is here and what is not follows one rule — the Host owns only what a browser cannot do. The
 * session list, the workspace list, the background-task list, archiving, and directory listing all
 * already reach the Web Client through capabilities it holds, so this endpoint adds no second copy
 * of any of them. It answers for git (a subprocess), panel terminals (a pseudo-terminal), file
 * previews (a filesystem read), external applications (a launch), stopping a background task
 * (an owner-fenced registry), and deletion (a durable artifact).
 *
 * Nothing here is model-facing: no tool, no prompt section, no session event. Every result is a
 * discriminated value rather than a throw, because the RPC gateway erases a business exception's
 * classification and each panel's next move depends on which class it was.
 * @module @achasoft/dsh-advanced-sidebar/host
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: the Context merges for the optional capabilities this service reads through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: the ctx.agentDefaultModel Context merge, read when drafting a commit message.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-jobs'
// Type-only: the ctx.llm Context merge.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionDeleter } from './deletion.ts'
import { FileReader } from './files.ts'
import { GitReader } from './git.ts'
import { OpenInLauncher } from './open-in.ts'
import { validateProxyTarget } from './preview-content.ts'
import { PreviewServers } from './preview.ts'
import { PROXY_ROUTE, PreviewSurface } from './preview-serve.ts'
import { PanelTerminals } from './terminals.ts'
import { TaskController } from './tasks.ts'
import { PreviewBindings } from './ui-bridge.ts'
import type { PreviewCommandBody } from './ui-preview-tool.ts'
import type {
  AdvancedSidebarSettings, AdvancedSidebarView, DeleteSessionRequest, DeleteSessionResult,
  GitCommitMessageRequest, GitCommitMessageResult, GitCommitRequest, GitCommitResult,
  GitDiffRequest, GitDiffResult, GitPushRequest, GitPushResult, GitStageRequest,
  GitStageResult, GitStatusRequest, GitStatusResult, ListEntriesRequest,
  ListEntriesResult, OpenInRequest, OpenInResult, PreviewBindRequest, PreviewCommandResult,
  PreviewFileInfoRequest, PreviewFileInfoResult, PreviewFileKind, PreviewListRequest,
  PreviewListResult, PreviewLogsRequest, PreviewLogsResult, PreviewPollRequest, PreviewPollResult,
  PreviewReleaseRequest, PreviewReleaseResult, PreviewResultAck, PreviewResultRequest,
  PreviewStartRequest, PreviewStartResult, PreviewStopRequest, PreviewStopResult,
  ReadFileRequest, ReadFileResult, TaskKillRequest, TaskKillResult, TaskOutputRequest,
  TaskOutputResult, TerminalAckResult, TerminalCloseRequest, TerminalOpenRequest,
  TerminalOpenResult, TerminalReadRequest, TerminalReadResult, TerminalSignalRequest,
  TerminalWriteRequest,
} from './types.ts'

export type * from './types.ts'
export { REVEAL_TARGET_ID } from './open-in.ts'

/**
 * The settings namespace both halves address; the browser card joins the plugin tab on it.
 *
 * Kebab-case, unlike the Remote namespace below: a settings namespace is a kebab-case grammar the
 * Host validates, while a Remote namespace is read as `ctx.remote.advancedSidebar.…` and so must be
 * an identifier.
 */
export const ADVANCED_SIDEBAR_SETTINGS_NAMESPACE = settingsNamespace('advanced-sidebar')

/** Deployment configuration for the advanced sidebar; the `advanced-sidebar` section's own shape. */
export type Config = AdvancedSidebarSettings

declare module '@deepseek-ai/cordis' {
  interface Context {
    advancedSidebar: AdvancedSidebarService
  }
}

/** An Open in target id must be usable in a menu and on the wire. */
const TARGET_ID_PATTERN = /^[a-z][a-z0-9-]*$/u

/**
 * Reject a section this service could not act on, for the constraints the schema cannot express.
 *
 * Called from the constructor as well as from the settings hook: the settings seam is optional, so
 * a composition without it never runs the hook — and these constraints come straight off the
 * composition file, where being wrong is a load-time mistake rather than a running deployment.
 * @param value - the resolved section, schema-valid by construction.
 */
function validateConfig(value: Config): void {
  const seen = new Set<string>(['reveal'])
  for (const editor of value.editors) {
    if (!TARGET_ID_PATTERN.test(editor.id)) {
      throw new TypeError(`advanced-sidebar: editor id "${editor.id}" must match ${String(TARGET_ID_PATTERN)}`)
    }
    if (seen.has(editor.id)) {
      throw new TypeError(
        `advanced-sidebar: editor id "${editor.id}" is used twice (or collides with the built-in file-manager target)`,
      )
    }
    seen.add(editor.id)
    if (editor.command.trim() === '') {
      throw new TypeError(`advanced-sidebar: editor "${editor.id}" has an empty command`)
    }
  }
  const names = new Set<string>()
  for (const preview of value.previews) {
    if (preview.name.trim() === '') {
      throw new TypeError('advanced-sidebar: a preview row has an empty name')
    }
    if (names.has(preview.name)) {
      throw new TypeError(`advanced-sidebar: preview name "${preview.name}" is used twice`)
    }
    names.add(preview.name)
    if (preview.runtimeExecutable === '' && preview.url === '' && preview.port <= 0) {
      throw new TypeError(
        `advanced-sidebar: preview "${preview.name}" names no command, no url, and no port,`
        + ' so there is nothing to start and nowhere to point the frame',
      )
    }
  }
  if (value.deleteMode === 'purge' && !value.confirmDelete) {
    throw new TypeError(
      'advanced-sidebar: deleteMode "purge" removes a session log irreversibly, so confirmDelete cannot be false',
    )
  }
}

/** Schemastery shape of one preview launch row. */
const PreviewSchema = z.object({
  name: z.string().required(),
  runtimeExecutable: z.string().required(),
  runtimeArgs: z.array(z.string()).required(),
  port: z.number().step(1).min(0).max(65_535).required(),
  url: z.string().required(),
  cwd: z.string().required(),
})

/** Schemastery shape of one Open in target row. */
const EditorSchema = z.object({
  id: z.string().required(),
  label: z.string().required(),
  command: z.string().required(),
  args: z.array(z.string()).required(),
})

/** Host endpoint for the sidebar's advanced operations, and owner of the settings section. */
export class AdvancedSidebarService extends TypertRemoteService {
  /** Loader validation for every deployment-varying choice this plugin makes. */
  static Config: z<Config> = z.object({
    showInSessionHeader: z.boolean().required(),
    showChanges: z.boolean().required(),
    showTerminal: z.boolean().required(),
    showFiles: z.boolean().required(),
    showTasks: z.boolean().required(),
    showOpenIn: z.boolean().required(),
    showArchive: z.boolean().required(),
    showDelete: z.boolean().required(),
    showPreview: z.boolean().required(),
    panelWidth: z.number().step(1).min(280).max(1_400).required(),
    confirmDelete: z.boolean().required(),
    deleteMode: z.union(['archive', 'purge'] as const).required(),
    allowTaskKill: z.boolean().required(),
    showTaskOutput: z.boolean().required(),
    gitMaxFiles: z.number().step(1).min(1).max(10_000).required(),
    gitDiffMaxBytes: z.number().step(1).min(1_024).max(16 * 1_024 * 1_024).required(),
    gitTimeoutMs: z.number().step(1).min(1_000).max(600_000).required(),
    gitCommitTimeoutMs: z.number().step(1).min(1_000).max(1_800_000).required(),
    allowGitStaging: z.boolean().required(),
    allowGitCommit: z.boolean().required(),
    allowGitPush: z.boolean().required(),
    gitPushTimeoutMs: z.number().step(1).min(1_000).max(1_800_000).required(),
    allowCommitMessageDraft: z.boolean().required(),
    commitMessagePrompt: z.string(),
    commitMessageMaxBytes: z.number().step(1).min(1_024).max(4 * 1_024 * 1_024).required(),
    terminalShell: z.string(),
    terminalScrollback: z.number().step(1).min(1_024).max(4 * 1_024 * 1_024).required(),
    maxTerminals: z.number().step(1).min(1).max(32).required(),
    terminalGraceMs: z.number().step(1).min(100).max(60_000).required(),
    filesMaxPreviewBytes: z.number().step(1).min(1_024).max(16 * 1_024 * 1_024).required(),
    filesMaxEntries: z.number().step(1).min(1).max(20_000).required(),
    filesShowHidden: z.boolean().required(),
    editors: z.array(EditorSchema).required(),
    previews: z.array(PreviewSchema).required(),
    previewsFromLaunchFile: z.boolean().required(),
    maxPreviews: z.number().step(1).min(1).max(16).required(),
    previewReadyTimeoutMs: z.number().step(1).min(1_000).max(600_000).required(),
    previewScrollback: z.number().step(1).min(1_024).max(4 * 1_024 * 1_024).required(),
    previewGraceMs: z.number().step(1).min(100).max(60_000).required(),
    previewMaxFileBytes: z.number().step(1).min(1_024).max(512 * 1_024 * 1_024).required(),
    previewProxyTimeoutMs: z.number().step(1).min(1_000).max(600_000).required(),
    previewCommandTimeoutMs: z.number().step(1).min(1_000).max(600_000).required(),
    previewBindTtlMs: z.number().step(1).min(1_000).max(120_000).required(),
  })

  private source: () => Config

  private readonly git: GitReader
  private readonly terminals: PanelTerminals
  private readonly launcher: OpenInLauncher
  private readonly files: FileReader
  private readonly tasks: TaskController
  private readonly deleter: SessionDeleter
  private readonly preview: PreviewServers
  private readonly surface: PreviewSurface
  private readonly bindings: PreviewBindings

  /**
   * @param ctx - Host context; every capability this service uses is resolved optionally, so a
   * deployment missing one still serves a view that explains which panel is dark and why.
   * @param config - the composition-layer preferences, used as the section's base layer.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'advancedSidebar')
    validateConfig(config)
    this.source = () => config
    const read = (): Config => this.source()

    this.git = new GitReader(ctx, read)
    this.terminals = new PanelTerminals(ctx, read)
    this.launcher = new OpenInLauncher(ctx, read)
    this.files = new FileReader(ctx, read)
    this.tasks = new TaskController(ctx, read)
    this.deleter = new SessionDeleter(ctx, read)
    this.preview = new PreviewServers(ctx, read)
    this.surface = new PreviewSurface(ctx, read)
    this.bindings = new PreviewBindings(() => {
      const settings = this.source()
      return {
        commandTimeoutMs: settings.previewCommandTimeoutMs,
        bindTtlMs: settings.previewBindTtlMs,
      }
    })
    // The routes are registered through the surface's own `ctx.inject(['webServer'], …)`, so a
    // headless deployment composes no route and needs no branch here.
    this.surface.install()

    installSettingsSection(ctx, ADVANCED_SIDEBAR_SETTINGS_NAMESPACE, AdvancedSidebarService.Config, config, {
      setSource: (current) => { this.source = current },
      // The one thing derived from the section is the Open in executable cache: an edited target
      // list must re-probe, or a corrected `command` would stay reported as unavailable.
      onChange: () => { this.launcher.forget() },
      validate: validateConfig,
    })

    // Cordis AWAITS an async disposer (`fiber.ts`: `await Promise.all(...map(runDisposable))`), so
    // the promise is returned rather than dropped: unload then finishes only once every panel
    // terminal and dev server this plugin started has actually exited. Each handle's own grace
    // escalation bounds how long that takes.
    ctx.effect(() => async () => {
      this.tasks.dispose()
      this.bindings.dispose()
      this.surface.dispose()
      await Promise.all([this.terminals.disposeAll(), this.preview.disposeAll()])
    }, 'advanced-sidebar: panel terminals, preview servers, retained task output')
  }

  /**
   * Describe which operations this Host can serve, so the menu can disable an entry with a reason
   * instead of offering one that fails when it is pressed.
   * @param signal - gateway-supplied cancellation for the executable probes.
   * @returns the capability view.
   */
  @Remote('describe')
  async describe(signal: AbortSignal): Promise<AdvancedSidebarView> {
    const settings = this.source()
    const deletion = this.deleter.describe()
    return {
      git: await this.git.describe(signal),
      terminal: this.terminals.describe(),
      files: this.files.describe(),
      preview: { ...this.preview.describe(), surface: this.surface.info() },
      tasks: this.tasks.describe(),
      openIn: await this.launcher.describe(signal),
      settings,
      deletion: {
        canPurge: deletion.canPurge,
        // A composition asking to purge on a backend that cannot is reported as `archive`, so the
        // confirmation dialog never promises a removal that will not happen.
        mode: settings.deleteMode === 'purge' && deletion.canPurge ? 'purge' : 'archive',
        ...deletion.reason === undefined ? {} : { reason: deletion.reason },
      },
      readAt: Date.now(),
    }
  }

  /**
   * Read one workspace's git status.
   * @param request - the workspace directory.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the reading, or a classified failure.
   */
  @Remote('gitStatus')
  gitStatus(request: GitStatusRequest, signal: AbortSignal): Promise<GitStatusResult> {
    return this.git.status(request, signal)
  }

  /**
   * Read one path's patch.
   * @param request - the path and which index to compare.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the patch, or a classified failure.
   */
  @Remote('gitDiff')
  gitDiff(request: GitDiffRequest, signal: AbortSignal): Promise<GitDiffResult> {
    return this.git.diff(request, signal)
  }

  /**
   * Stage paths into the index.
   * @param request - the workspace and the repository-relative paths.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the reading after the write, or a classified failure.
   */
  @Remote('gitStage')
  gitStage(request: GitStageRequest, signal: AbortSignal): Promise<GitStageResult> {
    return this.git.stage(request, signal)
  }

  /**
   * Take paths back out of the index, leaving the working tree alone.
   * @param request - the workspace and the repository-relative paths.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the reading after the write, or a classified failure.
   */
  @Remote('gitUnstage')
  gitUnstage(request: GitStageRequest, signal: AbortSignal): Promise<GitStageResult> {
    return this.git.unstage(request, signal)
  }

  /**
   * Record the staged changes.
   * @param request - the workspace, the message, and whether to amend.
   * @param signal - gateway-supplied cancellation; hooks run under `gitCommitTimeoutMs`.
   * @returns the new commit and the reading after it, or a classified failure.
   */
  @Remote('gitCommit')
  gitCommit(request: GitCommitRequest, signal: AbortSignal): Promise<GitCommitResult> {
    return this.git.commit(request, signal)
  }

  /**
   * Send the current branch's commits to its remote.
   * @param request - the workspace, and whether an unpublished branch may be published.
   * @param signal - gateway-supplied cancellation; the network wait runs under `gitPushTimeoutMs`.
   * @returns the push and the reading after it, or a classified failure.
   */
  @Remote('gitPush')
  gitPush(request: GitPushRequest, signal: AbortSignal): Promise<GitPushResult> {
    return this.git.push(request, signal)
  }

  /**
   * Ask the deployment's own model to write a commit message for what is staged.
   * @param request - the workspace, and whether the message is for an amend.
   * @param signal - gateway-supplied cancellation for the readings and the model call.
   * @returns the drafted message, or a classified failure.
   */
  @Remote('gitCommitMessage')
  gitCommitMessage(
    request: GitCommitMessageRequest, signal: AbortSignal,
  ): Promise<GitCommitMessageResult> {
    return this.git.draftCommitMessage(request, signal)
  }

  /**
   * Allocate a panel terminal.
   * @param request - the workspace directory and the panel's measured geometry.
   * @param signal - gateway-supplied cancellation of the allocation.
   * @returns the handle, or a classified failure.
   */
  @Remote('terminalOpen')
  terminalOpen(request: TerminalOpenRequest, signal: AbortSignal): Promise<TerminalOpenResult> {
    return this.terminals.open(request, signal)
  }

  /**
   * Read a panel terminal's output from a caller-owned offset.
   * @param request - the handle and the offset already rendered.
   * @returns the delta and the process state, or a classified failure.
   */
  @Remote('terminalRead')
  terminalRead(request: TerminalReadRequest): Promise<TerminalReadResult> {
    return Promise.resolve(this.terminals.read(request))
  }

  /**
   * Send keystrokes to a panel terminal.
   * @param request - the handle and the text to deliver verbatim.
   * @returns settlement, or a classified failure.
   */
  @Remote('terminalWrite')
  terminalWrite(request: TerminalWriteRequest): Promise<TerminalAckResult> {
    return this.terminals.write(request)
  }

  /**
   * Deliver a signal to a panel terminal's foreground process group.
   * @param request - the handle and the signal.
   * @returns settlement, or a classified failure.
   */
  @Remote('terminalSignal')
  terminalSignal(request: TerminalSignalRequest): Promise<TerminalAckResult> {
    return this.terminals.signal(request)
  }

  /**
   * Close a panel terminal.
   * @param request - the handle.
   * @returns settlement, or a classified failure.
   */
  @Remote('terminalClose')
  terminalClose(request: TerminalCloseRequest): Promise<TerminalAckResult> {
    return this.terminals.close(request)
  }

  /**
   * List one directory level for the Files panel.
   * @param request - the directory and the workspace it must stay inside.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the level, or a classified failure.
   */
  @Remote('listEntries')
  listEntries(request: ListEntriesRequest, signal: AbortSignal): Promise<ListEntriesResult> {
    return this.files.list(request, signal)
  }

  /**
   * List one workspace's preview launch configurations, each with its current state.
   * @param request - the workspace to read.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the list, or a classified failure.
   */
  @Remote('previewList')
  previewList(request: PreviewListRequest, signal: AbortSignal): Promise<PreviewListResult> {
    return this.preview.list(request, signal)
  }

  /**
   * Start one preview configuration.
   * @param request - the workspace and the configuration name.
   * @param signal - gateway-supplied cancellation of the start.
   * @returns the started row, or a classified failure.
   */
  @Remote('previewStart')
  previewStart(request: PreviewStartRequest, signal: AbortSignal): Promise<PreviewStartResult> {
    return this.preview.start(request, signal)
  }

  /**
   * Stop one running preview server.
   * @param request - the handle.
   * @returns settlement, or a classified failure.
   */
  @Remote('previewStop')
  previewStop(request: PreviewStopRequest): Promise<PreviewStopResult> {
    return this.preview.stop(request)
  }

  /**
   * Read one preview server's output from a caller-owned offset, with its state at read time.
   * @param request - the handle and the offset already rendered.
   * @returns the delta and the state, or a classified failure.
   */
  @Remote('previewLogs')
  previewLogs(request: PreviewLogsRequest): Promise<PreviewLogsResult> {
    return Promise.resolve(this.preview.logs(request))
  }

  /**
   * Describe one workspace file for the Preview panel's Files mode.
   *
   * Separate from `readFile`, which returns text for the Files panel's reader: a preview needs the
   * kind, the size, the same-origin URL, and a change token, and it must not pull a 200 MB video
   * through the wire to find out what it is.
   * @param request - the workspace and the file inside it.
   * @param signal - gateway-supplied cancellation for the resolution and metadata reads.
   * @returns the file's kind and frame URL, or a classified failure.
   */
  @Remote('previewFileInfo')
  previewFileInfo(
    request: PreviewFileInfoRequest, signal: AbortSignal,
  ): Promise<PreviewFileInfoResult> {
    return this.surface.info_(request.workspacePath, request.path, signal)
  }

  /**
   * Register one Preview panel and take whatever the agent queued for it.
   *
   * This is the polling half of the agent channel: the browser calls it while a preview is mounted,
   * the call is the panel's liveness heartbeat, and its answer carries the commands to execute.
   * @param request - which panel, where it is, and whether a preview is actually rendered.
   * @returns the work to do, or a classified failure.
   */
  @Remote('previewPoll')
  previewPoll(request: PreviewPollRequest): Promise<PreviewPollResult> {
    if (request.mounted) this.bindings.bind(request.bind)
    // A mounted poll always binds; a poll from a dock that has not rendered a preview yet may be
    // the first thing this Host hears from a tab, which is what lets a tool call wake it.
    else this.bindings.bindAt(request.bind)
    // The surface is told what the panel is framing so a subresource request the frame makes with no
    // target of its own can still be placed.
    this.surface.rememberTarget(request.clientId, request.bind.inspectable ? request.bind.url : undefined)
    const polled = this.bindings.poll(request.clientId, request.mounted)
    return Promise.resolve({ ok: true, message: polled.message, bindTtlMs: polled.bindTtlMs })
  }

  /**
   * Record what one command did.
   * @param request - the panel, the command id, and the outcome.
   * @returns settlement.
   */
  @Remote('previewResult')
  previewResult(request: PreviewResultRequest): Promise<PreviewResultAck> {
    this.bindings.post(
      request.clientId,
      request.id,
      request.ok
        ? request.result === undefined
          ? { ok: false, error: 'the panel reported success without a result' }
          : { ok: true, result: request.result }
        : { ok: false, error: request.error ?? 'the panel reported a failure with no reason' },
      request.console ?? [],
    )
    return Promise.resolve({ ok: true })
  }

  /**
   * Say that one panel is gone, so its queued work is dropped and its waits fail now.
   * @param request - the panel that closed.
   * @returns settlement.
   */
  @Remote('previewRelease')
  previewRelease(request: PreviewReleaseRequest): Promise<PreviewReleaseResult> {
    this.bindings.release(request.clientId)
    this.surface.rememberTarget(request.clientId, undefined)
    return Promise.resolve({ ok: true })
  }

  /**
   * Read one file for the Files panel preview.
   * @param request - the file and the workspace it must stay inside.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the preview, or a classified failure.
   */
  @Remote('readFile')
  readFile(request: ReadFileRequest, signal: AbortSignal): Promise<ReadFileResult> {
    return this.files.read(request, signal)
  }

  /**
   * Hand one path to an external application or to the operating system's file manager.
   * @param request - the target and the path.
   * @param signal - gateway-supplied cancellation for the launch.
   * @returns settlement, or a classified failure.
   */
  @Remote('openIn')
  openIn(request: OpenInRequest, signal: AbortSignal): Promise<OpenInResult> {
    return this.launcher.open(request, signal)
  }

  /**
   * Stop one live background task.
   * @param request - the owning session and the task id.
   * @returns what the registry did, or a classified failure.
   */
  @Remote('taskKill')
  taskKill(request: TaskKillRequest): Promise<TaskKillResult> {
    return this.tasks.kill(request)
  }

  /**
   * Read one settled background task's output.
   * @param request - the owning session and the task id.
   * @returns the accumulated output, or a classified failure.
   */
  @Remote('taskOutput')
  taskOutput(request: TaskOutputRequest): Promise<TaskOutputResult> {
    return this.tasks.output(request)
  }

  /**
   * Delete one session: archive it, and remove its durable artifact when the mode and Host allow.
   * @param request - the session to delete.
   * @param signal - gateway-supplied cancellation for the persistence listing.
   * @returns what was actually done, or a classified failure.
   */
  @Remote('deleteSession')
  deleteSession(request: DeleteSessionRequest, signal: AbortSignal): Promise<DeleteSessionResult> {
    return this.deleter.delete(request, signal)
  }

  /* ------------------------------------------------------------------------------------------- */
  /* The agent's own surface (ui_preview). In-process, not Remote: the tool holds this service.   */
  /* ------------------------------------------------------------------------------------------- */

  /**
   * Queue one command against the session's Preview panel and wait for its answer.
   * @param sessionId - the session whose panel should execute it.
   * @param body - the command, without its id, panel, or deadline.
   * @returns the result, or a sentence explaining why there is none.
   */
  queueCommand(
    sessionId: string, body: PreviewCommandBody,
  ): Promise<{ ok: true; result: PreviewCommandResult } | { ok: false; message: string }> {
    return this.bindings.queue(sessionId, {
      ...body,
      timeoutMs: this.source().previewCommandTimeoutMs,
    })
  }

  /**
   * Point the session's panel at a URL.
   *
   * The panel decides for itself how to frame it — a loopback URL goes through this Host's proxy and
   * becomes inspectable, anything else is framed cross-origin and is not — so the answer says which
   * happened rather than the tool guessing.
   * @param sessionId - the session whose panel should show it.
   * @param url - the absolute `http(s)` URL, already validated by the caller.
   * @param waitMs - how long the panel may take to mount and load.
   * @returns the outcome and what the panel is now framing.
   */
  async openUrl(
    sessionId: string, url: string, waitMs: number,
  ): Promise<
    | { ok: true; message: string; detail: Record<string, unknown> }
    | { ok: false; message: string }
  > {
    const clientId = this.bindings.active(sessionId)
    if (clientId === undefined) return { ok: false, message: NO_SURFACE }
    if (!this.bindings.control(clientId, { control: 'open', open: { clientId, mode: 'url', url } })) {
      return { ok: false, message: NO_SURFACE }
    }
    const sameOrigin = validateProxyTarget(url).ok
    const outcome = await this.bindings.send(clientId, { kind: 'open', timeoutMs: waitMs })
    if (!outcome.ok) return { ok: false, message: outcome.message }
    return {
      ok: true,
      message: sameOrigin
        ? `The Preview panel is loading ${url} through this Host's same-origin proxy, so its DOM, `
          + 'console and events are all inspectable.'
        : `The Preview panel is showing ${url}. It is not a loopback URL, so the frame stays `
          + 'cross-origin and cannot be inspected: dom, eval, click and type will refuse it.',
      detail: {
        url,
        inspectable: sameOrigin,
        ...sameOrigin ? { proxyRoute: PROXY_ROUTE } : {},
      },
    }
  }

  /**
   * Point the session's panel at one workspace file.
   * @param request - the session, the workspace, the file, its kind, and the wait budget.
   * @returns the outcome and where the panel is now framed from.
   */
  async openFile(request: {
    sessionId: string
    workspacePath: string
    filePath: string
    kind: PreviewFileKind
    waitMs: number
  }): Promise<
    | { ok: true; message: string; detail: Record<string, unknown> }
    | { ok: false; message: string }
  > {
    const clientId = this.bindings.active(request.sessionId)
    if (clientId === undefined) return { ok: false, message: NO_SURFACE }
    if (!this.bindings.control(clientId, {
      control: 'open',
      open: {
        clientId,
        mode: 'file',
        filePath: request.filePath,
        workspacePath: request.workspacePath,
      },
    })) {
      return { ok: false, message: NO_SURFACE }
    }
    const framed = this.surface.info().available
    if (request.kind !== 'iframe' && request.kind !== 'markdown' && !framed) {
      return {
        ok: false,
        message: `${request.filePath} is a ${request.kind} file, and this Host composes no web server, `
          + 'so there is no same-origin URL to frame it from',
      }
    }
    const outcome = await this.bindings.send(clientId, { kind: 'open', timeoutMs: request.waitMs })
    if (!outcome.ok) return { ok: false, message: outcome.message }
    const url = this.surface.fileUrl(request.workspacePath, request.filePath)
    return {
      ok: true,
      message: `The Preview panel is showing ${request.filePath} (${request.kind})`
        + `${request.kind === 'iframe' ? ' as a live document' : ''}; its DOM is same-origin and inspectable.`,
      detail: {
        path: request.filePath,
        kind: request.kind,
        ...url === undefined ? {} : { url },
      },
    }
  }

  /**
   * Read one workspace file's preview description, for the tool's own `open` validation.
   * @param request - the workspace and the file.
   * @param signal - cancellation for the reads.
   * @returns the description, or a classified failure.
   */
  describeFile(request: PreviewFileInfoRequest, signal?: AbortSignal): Promise<PreviewFileInfoResult> {
    return this.surface.info_(request.workspacePath, request.path, signal)
  }
}

/**
 * The refusal a tool call gets when no Preview panel is open in its session.
 *
 * A constant rather than a method: it is the same sentence for every action, and a model that reads
 * it twice should read the same thing twice.
 */
const NO_SURFACE = 'no Preview panel is open in this session, so there is nothing to inspect. Open '
  + 'the Preview panel first (the session header\'s Preview entry), then call this tool again.'

export default AdvancedSidebarService
