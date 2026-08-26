/**
 * Session deletion.
 *
 * No harness capability deletes a session: session persistence is append-only and exposes no delete
 * verb, and the workspace registry can only ARCHIVE — hide a session while keeping its log and its
 * accounting slot. Delete is therefore assembled here from the two things that do exist, and it is
 * honest about which one it managed:
 *
 * - `archive` hides the session. Reversible in principle (the durable slot is preserved), and the
 *   only mode that can act on a session that is currently live.
 * - `purge` additionally removes the persistence backend's own per-session artifact. Nothing undoes
 *   that, and a backend that keeps no per-session artifact (SQLite) reports the archive alone.
 *
 * A live session is never purged. Its writer holds the artifact open and a running turn would keep
 * appending to a file that no longer exists, so the archive commits and the reason is returned.
 * @module @achasoft/dsh-advanced-sidebar/host/deletion
 */

import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { AdvancedSidebarSettings, DeleteSessionRequest, DeleteSessionResult } from './types.ts'

/** What Delete can do on this Host right now. */
export interface DeletionCapability {
  /** Whether the persistence backend exposes a per-session artifact that could be removed. */
  readonly canPurge: boolean
  /** Why purging is unavailable, when it is. */
  readonly reason?: string
}

/**
 * Commits Delete for the sidebar menu. Stateless apart from the context and settings it reads.
 */
export class SessionDeleter {
  /**
   * @param ctx - Host context carrying the workspace registry and session persistence.
   * @param source - reads the current settings section; called per request.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * Report whether the durable log can be removed at all.
   * @returns the capability, with a reason when purging is impossible.
   */
  describe(): DeletionCapability {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      return { canPurge: false, reason: 'no session-persistence backend is mounted; nothing is written to remove' }
    }
    if (!persistence.supportsRawArtifacts) {
      return {
        canPurge: false,
        reason: 'this session-persistence backend keeps no per-session artifact, so Delete can only archive',
      }
    }
    return { canPurge: true }
  }

  /**
   * Hide one session, and remove its durable artifact when the mode and the Host allow it.
   * @param request - the session to delete.
   * @param signal - cancellation for the persistence listing.
   * @returns what was actually done, or a classified failure.
   */
  async delete(request: DeleteSessionRequest, signal?: AbortSignal): Promise<DeleteSessionResult> {
    const settings = this.source()
    if (!settings.showDelete) {
      return { ok: false, code: 'disabled', message: 'Delete is switched off in the advanced-sidebar settings' }
    }
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) {
      return { ok: false, code: 'no-registry', message: 'no workspace registry is mounted' }
    }
    const sessionId = request.sessionId as SessionId

    // Resolve the artifact BEFORE archiving: archiving is the irreversible-looking half from a
    // person's point of view, and failing after it would leave a hidden session whose log survived
    // with no surface left to retry from.
    const artifact = settings.deleteMode === 'purge'
      ? await this.locateArtifact(sessionId, signal)
      : undefined

    try {
      await registry.archiveSession(sessionId)
    } catch (error) {
      // Every archive rejection is reported under one code carrying the registry's own message.
      // Matching its wording to re-classify it would be a guess about text this package does not
      // own, and a storage fault phrased slightly differently would be shown as a stale row.
      return { ok: false, code: 'archive-failed', message: error instanceof Error ? error.message : String(error) }
    }

    if (settings.deleteMode === 'archive') return { ok: true, archived: true, purged: false }
    if (artifact === undefined || 'reason' in artifact) {
      return {
        ok: true,
        archived: true,
        purged: false,
        purgeSkippedReason: artifact?.reason ?? this.describe().reason
          ?? 'the session has no materialized artifact to remove',
      }
    }
    try {
      // The exact path the backend reported for this session, and nothing around it: a sidecar the
      // backend owns is the backend's to remove, and a recursive delete here could take a directory.
      await rm(artifact.path, { force: true })
    } catch (error) {
      return {
        ok: false,
        code: 'remove-failed',
        message: `archived, but ${artifact.path} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { ok: true, archived: true, purged: true, artifactPath: artifact.path }
  }

  /**
   * Find the backend artifact for one session, or say why it will not be removed.
   * @param sessionId - the session to look up.
   * @param signal - cancellation for the persistence listing.
   * @returns the artifact path, or the reason purging is skipped.
   */
  private async locateArtifact(
    sessionId: SessionId, signal?: AbortSignal,
  ): Promise<{ path: string } | { reason: string } | undefined> {
    const capability = this.describe()
    if (!capability.canPurge) return { reason: capability.reason ?? 'purging is unavailable on this Host' }
    // A live session's writer owns the file; removing it under an open turn would leave the writer
    // appending to an unlinked descriptor and lose the turn with no error anyone sees. Attachment is
    // read from the agent registry rather than the session store: an agent is what runs a turn, and
    // a cold session the store merely retains is not being written to.
    if (this.ctx.agents.get(sessionId) !== undefined) {
      return { reason: 'the session is live, so its log was kept; delete it again after it stops' }
    }
    const persistence = this.ctx.sessionPersistence
    let headers: readonly SessionHeader[]
    try {
      headers = await persistence.list(signal)
    } catch (error) {
      return { reason: `the durable session list could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
    const header = headers.find(entry => entry.id === sessionId)
    if (header === undefined) return { reason: 'the session has no durable log on this Host' }
    const location = persistence.locate(header)
    if (location === undefined) return { reason: 'this backend keeps no per-session artifact for that session' }
    return { path: location.path }
  }
}
