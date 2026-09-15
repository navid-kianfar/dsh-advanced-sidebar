/**
 * Session deletion.
 *
 * No harness capability deletes a session. Delete is therefore the one thing that does exist — the
 * workspace registry's ARCHIVE, which hides a session while keeping its log and its accounting slot —
 * and it is honest that this is all it did.
 *
 * `deleteMode: 'purge'` asked for more: the backend's own per-session artifact removed as well. On
 * the harness this release targets (`0.1.5-rc.2`) that cannot be done correctly, and so it is not
 * attempted:
 *
 * - The published `SessionPersistence` contract is `create`, `open`, `flush`, `stat` and `list`. It
 *   has no removal verb and no way to ask where a session's bytes live; the `supportsRawArtifacts`
 *   flag and `locate()` this module used to read were never part of it, so purging was silently
 *   impossible while the settings still offered it.
 * - The JSONL backend keeps a session as a DIRECTORY — one immutable file per format generation plus
 *   a `session.lock` write lease — behind an in-process cold-log memo, and the workspace registry and
 *   the session projection cache index its header. Unlinking files underneath all of that bypasses the
 *   lease another process may hold, leaves stale caches answering for a log that is gone, and is the
 *   same class of out-of-band edit that produces "torn record" corruption reports.
 *
 * So the capability is reported as unavailable with that reason, the settings card shows the reason
 * and refuses to select `purge`, and a composition that still configures it gets an archive whose
 * result says, every time, why nothing was removed. When the harness grows a supported removal verb,
 * this is the one module to change.
 * @module @achasoft/dsh-advanced-sidebar/host/deletion
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AdvancedSidebarSettings, DeleteSessionRequest, DeleteSessionResult } from './types.ts'

/** What Delete can do on this Host right now. */
export interface DeletionCapability {
  /** Whether a session's durable log can be removed. Always false on this harness; see the module. */
  readonly canPurge: boolean
  /** Why purging is unavailable, when it is. */
  readonly reason?: string
}

/**
 * Why `purge` is unavailable, in the words the settings card and the Delete result show.
 *
 * One sentence for both, so the reason a person reads before choosing a mode is the reason they read
 * after pressing Delete.
 */
export const PURGE_UNAVAILABLE_REASON = 'this harness\'s session persistence has no supported way to remove '
  + 'a session log, so Delete archives the session and keeps its log'

/**
 * Commits Delete for the sidebar menu. Stateless apart from the context and settings it reads.
 */
export class SessionDeleter {
  /**
   * @param ctx - Host context carrying the workspace registry.
   * @param source - reads the current settings section; called per request.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * Report whether the durable log can be removed at all.
   * @returns the capability, with the reason purging is impossible.
   */
  describe(): DeletionCapability {
    return { canPurge: false, reason: PURGE_UNAVAILABLE_REASON }
  }

  /**
   * Hide one session, and say plainly when a requested purge did not happen.
   * @param request - the session to delete.
   * @returns what was actually done, or a classified failure.
   */
  async delete(request: DeleteSessionRequest): Promise<DeleteSessionResult> {
    const settings = this.source()
    if (!settings.showDelete) {
      return { ok: false, code: 'disabled', message: 'Delete is switched off in the advanced-sidebar settings' }
    }
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      return { ok: false, code: 'no-registry', message: 'no workspace registry is mounted' }
    }
    try {
      await registry.archiveSession(request.sessionId as SessionId)
    } catch (error) {
      // Every archive rejection is reported under one code carrying the registry's own message.
      // Matching its wording to re-classify it would be a guess about text this package does not
      // own, and a storage fault phrased slightly differently would be shown as a stale row.
      return { ok: false, code: 'archive-failed', message: error instanceof Error ? error.message : String(error) }
    }
    switch (settings.deleteMode) {
      case 'archive':
        return { ok: true, archived: true, purged: false }
      case 'purge':
        return { ok: true, archived: true, purged: false, purgeSkippedReason: PURGE_UNAVAILABLE_REASON }
      default:
        throw new TypeError(`advanced-sidebar: unexpected deleteMode ${JSON.stringify(settings.deleteMode satisfies never)}`)
    }
  }
}
