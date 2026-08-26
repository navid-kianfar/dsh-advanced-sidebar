/**
 * Resolving what the menu acts on.
 *
 * Both menu seats answer the same question — which session, and which directory — from different
 * starting points: the sidebar foot is root-scoped and must find the current session itself, while
 * the session header is handed one. The resolution rule is shared so the two seats can never
 * disagree about the target of an identical menu.
 * @module @achasoft/dsh-advanced-sidebar/client/target
 */

import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { OperationTarget } from './controller.ts'

/**
 * Build the operation target for one session.
 *
 * The directory is the session's own cwd first, and its Workspace's path only as a fallback: a
 * session started inside a subdirectory works there, and reading git or opening a terminal at the
 * Workspace root would silently act on a different tree than the model does.
 * @param sessions - the session list snapshot.
 * @param workspaces - the workspace list snapshot.
 * @param sessionId - the session to describe; absent yields no target.
 * @returns the target, or undefined when no session is selected or the id is not listed.
 */
export function resolveTarget(
  sessions: SessionListState,
  workspaces: WorkspaceListState,
  sessionId: string | undefined,
): OperationTarget | undefined {
  if (sessionId === undefined) return undefined
  const summary = sessions.byId[sessionId as keyof typeof sessions.byId]
  if (summary === undefined) return undefined
  const workspace = workspaces.items.find(item => (item.sessionIds as readonly string[]).includes(sessionId))
  const directory = summary.cwd ?? workspace?.path
  return {
    sessionId,
    title: summary.displayTitle,
    ...directory === undefined ? { directory: undefined } : { directory },
  }
}
