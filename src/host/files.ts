/**
 * File previews for the Files panel.
 *
 * Directory listing is not here: the Web Client already reaches the Host's own `browse` capability
 * through `ctx.workspaces.listDirectory`, so the panel walks the tree with the same capability the
 * workspace picker uses and this module owns only the read that surface has no verb for.
 * @module @achasoft/dsh-advanced-sidebar/host/files
 */

import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveInside, resolveWorkspace } from './paths.ts'
import type {
  AdvancedSidebarSettings, CapabilityState, DirectoryEntryView, ListEntriesRequest,
  ListEntriesResult, ReadFileRequest, ReadFileResult,
} from './types.ts'

/**
 * How much of a file's head decides whether it is text. A NUL byte anywhere in this window is the
 * same test `git` uses, and it is cheap enough to apply to every preview.
 */
const BINARY_PROBE_BYTES = 8_000

/** Reads file previews for the Files panel. */
export class FileReader {
  /**
   * @param ctx - Host context carrying the optional filesystem capability.
   * @param source - reads the current settings section; called per request.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * Report whether a preview can be read on this Host.
   * @returns availability, with the reason when there is no filesystem.
   */
  describe(): CapabilityState {
    if (this.ctx.get('fs') === undefined) {
      return {
        available: false,
        reason: 'no filesystem capability is mounted: this deployment composes no @deepseek-ai/dsh-fs provider',
      }
    }
    return { available: true }
  }

  /**
   * List one directory level inside a workspace.
   *
   * The Web Client's own `listDirectory` cannot serve this panel: the Host's browse capability
   * returns directories only, because its one caller is a workspace picker. A file browser needs
   * the files.
   * @param request - the directory and the workspace it must stay inside.
   * @param signal - cancellation for the listing.
   * @returns the level, or a classified failure.
   */
  async list(request: ListEntriesRequest, signal?: AbortSignal): Promise<ListEntriesResult> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      return { ok: false, code: 'no-filesystem', message: 'no filesystem capability is mounted' }
    }
    const workspace = await resolveWorkspace(this.ctx, request.workspacePath, signal)
    if (!workspace.ok) {
      return {
        ok: false,
        code: workspace.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
        message: workspace.rejection.message,
      }
    }
    const directory = await resolveInside(this.ctx, workspace.value, request.path, signal)
    if (!directory.ok) {
      return {
        ok: false,
        code: directory.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
        message: directory.rejection.message,
      }
    }
    const info = await fs.stat(directory.value.target, signal)
    if (info === undefined || info.type !== 'directory') {
      return { ok: false, code: 'not-a-file', message: `${request.path} is not a directory` }
    }

    let children
    try {
      children = await fs.listDir(directory.value.target, signal)
    } catch (error) {
      return { ok: false, code: 'read-failed', message: error instanceof Error ? error.message : String(error) }
    }
    const settings = this.source()
    const visible = children.filter(child => settings.filesShowHidden || !child.name.startsWith('.'))
    const sorted = visible
      .map((child): DirectoryEntryView => ({
        name: child.name,
        path: fs.processPath(child.target),
        kind: child.type,
        ...child.size === undefined ? {} : { size: child.size },
      }))
      // Directories first, then files, each name-sorted — the ordering every file browser uses,
      // and `listDir` guarantees none of its own.
      .sort((left, right) => {
        const leftDirectory = left.kind === 'directory'
        if (leftDirectory !== (right.kind === 'directory')) return leftDirectory ? -1 : 1
        return left.name.localeCompare(right.name)
      })
    const truncated = sorted.length > settings.filesMaxEntries
    // The workspace root has no parent the panel may reach: climbing out of it would list a tree
    // the containment check exists to keep it out of.
    const atRoot = fs.contains(directory.value.target, workspace.value.target)
    const parent = atRoot ? undefined : dirname(directory.value.processPath)
    return {
      ok: true,
      path: directory.value.processPath,
      ...parent === undefined ? {} : { parent },
      entries: truncated ? sorted.slice(0, settings.filesMaxEntries) : sorted,
      truncated,
    }
  }

  /**
   * Read one file, bounded by `filesMaxPreviewBytes`.
   * @param request - the file and the workspace it must stay inside.
   * @param signal - cancellation for the read.
   * @returns the preview, or a classified failure.
   */
  async read(request: ReadFileRequest, signal?: AbortSignal): Promise<ReadFileResult> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      return { ok: false, code: 'no-filesystem', message: 'no filesystem capability is mounted' }
    }
    const workspace = await resolveWorkspace(this.ctx, request.workspacePath, signal)
    if (!workspace.ok) {
      return {
        ok: false,
        code: workspace.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
        message: workspace.rejection.message,
      }
    }
    const file = await resolveInside(this.ctx, workspace.value, request.path, signal)
    if (!file.ok) {
      return {
        ok: false,
        code: file.rejection.code === 'no-filesystem' ? 'no-filesystem' : 'path-denied',
        message: file.rejection.message,
      }
    }
    const info = await fs.stat(file.value.target, signal)
    if (info === undefined || info.type !== 'file') {
      return { ok: false, code: 'not-a-file', message: `${request.path} is not a regular file` }
    }

    const max = this.source().filesMaxPreviewBytes
    let bytes: Uint8Array
    try {
      bytes = await fs.readBytes(file.value.target, signal, max)
    } catch (error) {
      return {
        ok: false,
        code: 'read-failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    const size = info.size ?? bytes.byteLength
    if (isBinary(bytes)) {
      return { ok: true, path: request.path, text: '', binary: true, truncated: false, bytes: size }
    }
    return {
      ok: true,
      path: request.path,
      // Non-fatal decoding: a preview cut at `max` can end mid-sequence, and one replacement
      // character at the tail is a better answer than refusing the whole file.
      text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      binary: false,
      truncated: size > bytes.byteLength,
      bytes: size,
    }
  }
}

/**
 * Whether a file's leading bytes look like something other than text.
 * @param bytes - the read window.
 * @returns true when a NUL appears in the probe window.
 */
function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, BINARY_PROBE_BYTES)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}
