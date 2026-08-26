/**
 * Path resolution and containment for every endpoint that takes a path from the browser.
 *
 * A browser-supplied path is untrusted input at a process boundary, so each one is resolved through
 * `ctx.fs` and proved to sit inside the workspace it claims to belong to before any command, read,
 * or launch sees it. `..` and symlinks are handled by the filesystem's own canonicalization rather
 * than by string arithmetic here.
 * @module @achasoft/dsh-advanced-sidebar/host/paths
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

/** A resolved, contained path plus the canonical spelling a subprocess can open. */
export interface ResolvedPath {
  /** The canonical target. */
  readonly target: FsTarget
  /** Absolute path in the filesystem backend's execution world. */
  readonly processPath: string
}

/** Why a path could not be accepted. */
export type PathRejection =
  /** No filesystem capability is mounted. */
  | { readonly code: 'no-filesystem'; readonly message: string }
  /** The path does not exist, or escaped the workspace it was asked about. */
  | { readonly code: 'path-denied'; readonly message: string }

/** Either a usable path or the reason it was refused. */
export type PathOutcome =
  | { readonly ok: true; readonly value: ResolvedPath }
  | { readonly ok: false; readonly rejection: PathRejection }

/**
 * Resolve one absolute directory as a workspace root.
 * @param ctx - Host context carrying the optional filesystem capability.
 * @param path - absolute directory path supplied by the browser.
 * @param signal - cancellation for the backend round-trip.
 * @returns the canonical directory, or the reason it was refused.
 */
export async function resolveWorkspace(
  ctx: Context, path: string, signal?: AbortSignal,
): Promise<PathOutcome> {
  const fs = ctx.get('fs')
  if (fs === undefined) {
    return {
      ok: false,
      rejection: {
        code: 'no-filesystem',
        message: 'no filesystem capability is mounted: this deployment composes no @deepseek-ai/dsh-fs provider',
      },
    }
  }
  let target: FsTarget
  try {
    target = await fs.resolve(path, signal === undefined ? {} : { signal })
  } catch (error) {
    return { ok: false, rejection: { code: 'path-denied', message: describe(error, path) } }
  }
  const info = await fs.stat(target, signal)
  if (info === undefined || info.type !== 'directory') {
    return { ok: false, rejection: { code: 'path-denied', message: `${path} is not a directory` } }
  }
  return { ok: true, value: { target, processPath: fs.processPath(target) } }
}

/**
 * Resolve one path and prove it sits inside an already-resolved workspace.
 * @param ctx - Host context carrying the optional filesystem capability.
 * @param workspace - the canonical workspace directory the path must stay within.
 * @param path - absolute path supplied by the browser.
 * @param signal - cancellation for the backend round-trip.
 * @returns the canonical path, or the reason it was refused.
 */
export async function resolveInside(
  ctx: Context, workspace: ResolvedPath, path: string, signal?: AbortSignal,
): Promise<PathOutcome> {
  const fs = ctx.get('fs')
  /* v8 ignore next 4 -- the caller resolved `workspace` through the same service moments earlier. */
  if (fs === undefined) {
    return { ok: false, rejection: { code: 'no-filesystem', message: 'filesystem capability withdrawn mid-request' } }
  }
  let target: FsTarget
  try {
    target = await fs.resolve(path, signal === undefined ? {} : { signal })
  } catch (error) {
    return { ok: false, rejection: { code: 'path-denied', message: describe(error, path) } }
  }
  if (!fs.contains(workspace.target, target)) {
    return {
      ok: false,
      rejection: { code: 'path-denied', message: `${path} is outside ${workspace.target.displayPath}` },
    }
  }
  return { ok: true, value: { target, processPath: fs.processPath(target) } }
}

/**
 * Phrase one resolution failure without leaking a stack.
 * @param error - whatever the backend threw.
 * @param path - the path that was being resolved.
 * @returns a single-line operator diagnostic.
 */
function describe(error: unknown, path: string): string {
  return `cannot resolve ${path}: ${error instanceof Error ? error.message : String(error)}`
}
