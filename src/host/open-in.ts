/**
 * The Open in submenu's Host half: reveal a path in the operating system's file manager, and launch
 * a configured external application on it.
 *
 * The harness's own `host.openPath` hands a path to its default application, which is the right
 * verb for a directory and the wrong one for a file — a person asking to see a file in Finder does
 * not want it opened in whatever edits `.ts`. This module keeps that distinction: a directory is
 * opened, a file is selected in its folder.
 * @module @achasoft/dsh-advanced-sidebar/host/open-in
 */

import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveWorkspace } from './paths.ts'
import { CommandUnavailableError, resolveCommand, runCommand } from './run.ts'
import type {
  AdvancedSidebarSettings, OpenInFailureCode, OpenInRequest, OpenInResult, OpenInTargetView,
} from './types.ts'

/** Id of the built-in file-manager target; no configured editor may claim it. */
export const REVEAL_TARGET_ID = 'reveal'

/** Wall-clock bound on a launch. A desktop opener returns immediately or is broken. */
const LAUNCH_TIMEOUT_MS = 15_000

/** TERM-to-KILL grace for a launcher that ignored its deadline. */
const LAUNCH_GRACE_MS = 2_000

/** Compose one classified failure. */
function fail(code: OpenInFailureCode, message: string): OpenInResult {
  return { ok: false, code, message }
}

/** The file manager's name on this platform, used as the target's menu text. */
function revealLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Finder'
  if (platform === 'win32') return 'File Explorer'
  return 'File manager'
}

/**
 * Launches external applications for the Open in submenu. One instance serves every request and
 * caches each target's resolved executable.
 */
export class OpenInLauncher {
  private readonly resolved = new Map<string, string | undefined>()

  /**
   * @param ctx - Host context carrying the subprocess and filesystem capabilities.
   * @param source - reads the current settings section; called per request so an edited target list
   * reaches the next menu with no registration to rebuild.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * List every target in menu order with its availability.
   *
   * Unavailable targets are listed rather than hidden: a person who configured an editor and does
   * not see it cannot tell a typo in `command` from a menu that simply has no such feature.
   * @param signal - cancellation for the executable lookups.
   * @returns the targets, file manager first.
   */
  async describe(signal?: AbortSignal): Promise<readonly OpenInTargetView[]> {
    const platform = process.platform
    const views: OpenInTargetView[] = [{
      id: REVEAL_TARGET_ID,
      label: revealLabel(platform),
      available: await this.available(this.revealCommand(platform).argv[0] ?? '', signal),
      kind: 'reveal',
    }]
    for (const editor of this.source().editors) {
      views.push({
        id: editor.id,
        label: editor.label,
        available: await this.available(editor.command, signal),
        kind: 'command',
      })
    }
    return views
  }

  /**
   * Hand one path to a target.
   * @param request - which target, and which absolute path.
   * @param signal - cancellation for the launch.
   * @returns settlement, or a classified failure.
   */
  async open(request: OpenInRequest, signal?: AbortSignal): Promise<OpenInResult> {
    // The path is proved to exist by resolving it as its own root: `openIn` is reached from a
    // workspace row or a Files-panel row, both of which name a path the Host already listed.
    const resolvedPath = await resolveWorkspace(this.ctx, request.path, signal)
    const target = resolvedPath.ok
      ? resolvedPath.value.processPath
      : await this.resolveFile(request.path, signal)
    if (target === undefined) {
      return fail('path-denied', `${request.path} does not exist on this Host`)
    }
    const directory = resolvedPath.ok

    if (request.targetId === REVEAL_TARGET_ID) return this.reveal(target, directory, signal)

    const editor = this.source().editors.find(entry => entry.id === request.targetId)
    if (editor === undefined) return fail('unknown-target', `no Open in target "${request.targetId}"`)
    const executable = await this.locate(editor.command, signal)
    if (executable === undefined) {
      return fail('unavailable', `${editor.label}: "${editor.command}" does not resolve on this Host`)
    }
    return this.launch([executable, ...editor.args, target], signal)
  }

  /**
   * Show a path in the operating system's file manager.
   * @param target - the canonical path.
   * @param directory - whether the path is a directory (opened) or a file (selected).
   * @param signal - cancellation for the launch.
   * @returns settlement, or a classified failure.
   */
  private async reveal(target: string, directory: boolean, signal?: AbortSignal): Promise<OpenInResult> {
    const platform = process.platform
    const { argv, tolerateExit } = this.revealCommand(platform, target, directory)
    const command = argv[0]
    if (command === undefined) {
      return fail('unavailable', `no file manager is known for ${platform}`)
    }
    const executable = await this.locate(command, signal)
    if (executable === undefined) {
      return fail('unavailable', `${command} does not resolve on this Host`)
    }
    return this.launch([executable, ...argv.slice(1)], signal, tolerateExit)
  }

  /**
   * The platform's file-manager invocation.
   * @param platform - the Host platform.
   * @param target - the canonical path; omitted while only the executable name is needed.
   * @param directory - whether the path is a directory.
   * @returns the argv and whether a non-zero exit is normal for it.
   */
  private revealCommand(
    platform: NodeJS.Platform, target = '', directory = true,
  ): { argv: readonly string[]; tolerateExit: boolean } {
    if (platform === 'darwin') {
      return { argv: directory ? ['open', target] : ['open', '-R', target], tolerateExit: false }
    }
    if (platform === 'win32') {
      // `explorer` exits 1 on success, which is documented behavior and not an error.
      return {
        argv: directory ? ['explorer.exe', target] : ['explorer.exe', `/select,${target}`],
        tolerateExit: true,
      }
    }
    // No portable "select this file" verb exists on Linux desktops, so a file opens its folder.
    return { argv: ['xdg-open', directory ? target : dirname(target)], tolerateExit: false }
  }

  /**
   * Run one launcher and classify its outcome.
   * @param argv - resolved executable and arguments.
   * @param signal - cancellation for the launch.
   * @param tolerateExit - accept a non-zero exit as success (Windows Explorer).
   * @returns settlement, or a classified failure.
   */
  private async launch(
    argv: readonly string[], signal?: AbortSignal, tolerateExit = false,
  ): Promise<OpenInResult> {
    let outcome
    try {
      outcome = await runCommand(this.ctx, {
        argv,
        // The launcher's own directory is irrelevant — every path it receives is absolute — and the
        // process cwd is the one directory guaranteed to exist.
        cwd: process.cwd(),
        timeoutMs: LAUNCH_TIMEOUT_MS,
        maxBytes: 8_192,
        graceMs: LAUNCH_GRACE_MS,
      }, signal)
    } catch (error) {
      if (error instanceof CommandUnavailableError) return fail('unavailable', error.message)
      throw error
    }
    if (outcome.timedOut) return fail('timeout', `${argv[0] ?? 'launcher'} did not return within ${String(LAUNCH_TIMEOUT_MS)}ms`)
    if (outcome.exitCode === 0 || tolerateExit) return { ok: true }
    const detail = outcome.stderr.trim()
    return fail(
      'launch-failed',
      detail === '' ? `${argv[0] ?? 'launcher'} exited with code ${String(outcome.exitCode)}` : detail,
    )
  }

  /**
   * Resolve a file path that is not a directory.
   * @param path - the browser-supplied path.
   * @param signal - cancellation for the resolution.
   * @returns the canonical path, or undefined when nothing is there.
   */
  private async resolveFile(path: string, signal?: AbortSignal): Promise<string | undefined> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return undefined
    try {
      const resolved = await fs.resolve(path, signal === undefined ? {} : { signal })
      const info = await fs.stat(resolved, signal)
      return info === undefined ? undefined : fs.processPath(resolved)
    } catch {
      // A path that will not resolve is reported to the caller as `path-denied`; there is nothing
      // else this launcher could do with the resolution error.
      return undefined
    }
  }

  /**
   * Whether one command resolves, without reporting why it does not.
   * @param command - executable name or path.
   * @param signal - cancellation for the lookup.
   * @returns true when the command resolves.
   */
  private async available(command: string, signal?: AbortSignal): Promise<boolean> {
    if (command === '') return false
    try {
      return (await this.locate(command, signal)) !== undefined
    } catch (error) {
      /* v8 ignore next -- only a missing subprocess capability reaches here. */
      if (error instanceof CommandUnavailableError) return false
      /* v8 ignore next */
      throw error
    }
  }

  /**
   * Resolve one command once and remember the answer, negative answers included.
   * @param command - executable name or path.
   * @param signal - cancellation for the lookup.
   * @returns the executable path, or undefined when the command is absent.
   * @throws {CommandUnavailableError} when no subprocess capability is mounted.
   */
  private async locate(command: string, signal?: AbortSignal): Promise<string | undefined> {
    // `has`, not a truthy read: `undefined` is a real cached answer ("this command is absent"),
    // and re-probing it on every menu open would spend a PATH scan per unavailable target.
    if (this.resolved.has(command)) return this.resolved.get(command)
    const found = await resolveCommand(this.ctx, command, signal)
    // A negative answer is cached too, but only until the settings section changes: `forget()` is
    // what lets an operator install an editor and see the menu row go live without a restart.
    this.resolved.set(command, found)
    return found
  }

  /** Drop every cached lookup, so an edited target list or a newly installed editor is re-probed. */
  forget(): void {
    this.resolved.clear()
  }
}
