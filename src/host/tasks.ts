/**
 * Background-task control for the Tasks panel.
 *
 * The list itself is not here: the Host already pushes `session/jobs` frames that the Web Client
 * folds into its `jobsBySession` mirror, so the panel reads the same live data every other surface
 * reads and this module owns only the two verbs that mirror has no wire for — stop, and output.
 *
 * Output is the delicate one. `ctx.jobs.read()` CONSUMES a stream job's delta, and the model reads
 * the same cursor through its own jobs tool; draining it for a person would silently delete output
 * the model was about to receive. So output is served only once the registry has marked the record
 * reported — after a kill, a wait, or a model read — and the text is accumulated here so reopening
 * the panel shows the same output instead of an empty second read.
 * @module @achasoft/dsh-advanced-sidebar/host/tasks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobRegistry, type JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AdvancedSidebarSettings, CapabilityState, TaskFailure, TaskFailureCode, TaskKillRequest,
  TaskKillResult, TaskOutputRequest, TaskOutputResult,
} from './types.ts'

/** Compose one classified failure. */
function fail(code: TaskFailureCode, message: string): TaskFailure {
  return { ok: false, code, message }
}

/** Whether the registry still holds the record open. */
function isLive(snapshot: JobSnapshot): boolean {
  return snapshot.status === 'running' || snapshot.status === 'stopping'
}

/**
 * Stops and reads background tasks on behalf of the Tasks panel. One instance serves every request
 * and retains the output it has already drained.
 */
export class TaskController {
  /** Accumulated output per job id, so a second panel open is not an empty read. */
  private readonly collected = new Map<string, string>()

  /**
   * @param ctx - Host context carrying the optional job registry and the agent registry.
   * @param source - reads the current settings section; called per request.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * Report what the Tasks panel may do on this Host.
   * @returns availability plus the two per-verb permissions.
   */
  describe(): CapabilityState & { canKill: boolean; canReadOutput: boolean } {
    const settings = this.source()
    if (this.ctx.get('jobs') === undefined) {
      return {
        available: false,
        reason: 'no job registry is mounted: this deployment composes no @deepseek-ai/dsh-jobs provider',
        canKill: false,
        canReadOutput: false,
      }
    }
    return {
      available: true,
      canKill: settings.allowTaskKill,
      canReadOutput: settings.showTaskOutput,
    }
  }

  /**
   * Stop one live task.
   *
   * The registry marks a killed record reported, which suppresses the completion notice its
   * producer would otherwise open a model turn to deliver. That is the correct trade for a person
   * pressing Stop — the work is being cancelled on their authority, not the model's — and it is why
   * this verb is gated by `allowTaskKill` rather than always on.
   * @param request - the owning session and the task id.
   * @returns what the registry did, or a classified failure.
   */
  async kill(request: TaskKillRequest): Promise<TaskKillResult> {
    if (!this.source().allowTaskKill) {
      return fail('disabled', 'stopping a background task is switched off in the advanced-sidebar settings')
    }
    const bound = this.bind(request.sessionId, request.taskId)
    if ('failure' in bound) return bound.failure
    try {
      const outcome = bound.jobs.kill(bound.id, bound.agent, 'stopped from the DeepSeek Harness sidebar')
      // A kill settles the record, so this is the moment its output becomes safe to keep.
      await this.absorb(request.sessionId, request.taskId)
      return { ok: true, outcome }
    } catch (error) {
      return fail('registry-refused', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Read one task's output, or say why it is withheld.
   * @param request - the owning session and the task id.
   * @returns the accumulated output, or a classified failure.
   */
  async output(request: TaskOutputRequest): Promise<TaskOutputResult> {
    if (!this.source().showTaskOutput) {
      return fail('disabled', 'task output is switched off in the advanced-sidebar settings')
    }
    const bound = this.bind(request.sessionId, request.taskId)
    if ('failure' in bound) return bound.failure

    let snapshot: JobSnapshot
    try {
      snapshot = bound.jobs.get(bound.id, bound.agent)
    } catch (error) {
      return fail('unknown-task', error instanceof Error ? error.message : String(error))
    }

    const retained = this.collected.get(request.taskId) ?? ''
    if (isLive(snapshot) || !snapshot.reported) {
      return {
        ok: true,
        taskId: request.taskId,
        readable: retained !== '',
        text: retained,
        reason: isLive(snapshot)
          ? 'the task is still running; its output stream belongs to the model until the task settles'
          : 'the task has settled but its completion has not been reported to the model yet',
      }
    }
    await this.absorb(request.sessionId, request.taskId)
    return { ok: true, taskId: request.taskId, readable: true, text: this.collected.get(request.taskId) ?? '' }
  }

  /** Drop retained output. Called from the service's teardown effect. */
  dispose(): void {
    this.collected.clear()
  }

  /**
   * Drain whatever the registry will still hand over and append it to the retained text.
   * @param sessionId - the owning session.
   * @param taskId - the task id.
   */
  private async absorb(sessionId: string, taskId: string): Promise<void> {
    const bound = this.bind(sessionId, taskId)
    if ('failure' in bound) return
    try {
      const read = bound.jobs.read(bound.id, bound.agent)
      if (read.text !== '') {
        this.collected.set(taskId, (this.collected.get(taskId) ?? '') + read.text)
      }
    } catch {
      // The registry refuses a record it has dropped, which is indistinguishable here from one that
      // never existed; either way the retained text is all there will ever be.
    }
    // `read` is synchronous on every shipped registry; awaiting nothing keeps this method's
    // signature stable if a remote registry ever needs a round trip.
    await Promise.resolve()
  }

  /**
   * Resolve the registry, the owning agent, and the branded job id together.
   * @param sessionId - the owning session, as the browser spelled it.
   * @param taskId - the task id, as the browser spelled it.
   * @returns the bound handles, or the failure to return.
   */
  private bind(sessionId: string, taskId: string):
  { jobs: JobRegistry; agent: Agent; id: JobId } | { failure: TaskFailure } {
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined) return { failure: fail('no-registry', 'no job registry is mounted') }
    const agent = this.ctx.agents.get(sessionId as SessionId)
    if (agent === undefined) {
      // Jobs are fenced on the owner's session, and the registry would hand a non-agent caller only
      // unowned records — so a session with no live agent has nothing this panel may act on.
      return { failure: fail('unknown-session', `no live agent answers for session ${sessionId}`) }
    }
    return { jobs, agent, id: JobId(taskId) }
  }
}
