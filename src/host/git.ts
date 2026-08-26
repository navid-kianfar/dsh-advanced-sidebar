/**
 * Git readings for the Changes panel.
 *
 * The harness has no git capability, so this reads a repository the only way available to a plugin:
 * by running `git` through `ctx.subprocess` and parsing its machine formats. Nothing here writes to
 * a repository — the panel shows what changed and what one path's patch looks like, and every
 * argument list is fixed here rather than assembled from browser text.
 * @module @achasoft/dsh-advanced-sidebar/host/git
 */

import type { Context } from '@deepseek-ai/cordis'
import { isStaged, isUnstaged, parsePorcelainV2 } from './porcelain.ts'
import { resolveWorkspace, type PathOutcome } from './paths.ts'
import { CommandUnavailableError, resolveCommand, runCommand, type CommandOutcome } from './run.ts'
import type {
  AdvancedSidebarSettings, CapabilityState, GitDiffRequest, GitDiffResult, GitFailure,
  GitFailureCode, GitFileChange, GitStatusRequest, GitStatusResult,
} from './types.ts'

/**
 * `git`'s own separator between the two paths of a rename record and between status lines.
 * Requested explicitly (`-z`) so a path containing a newline or a quote cannot be misread — git's
 * default output would C-quote such a path and this parser would then compare a quoted spelling
 * against the unquoted one a later diff request repeats.
 */
const NUL_ARGS = ['-z'] as const

/** Compose one classified failure. */
function fail(code: GitFailureCode, message: string): GitFailure {
  return { ok: false, code, message }
}

/** First non-empty line of git's stderr, which is the part worth showing. */
function stderrLine(outcome: CommandOutcome): string {
  const line = outcome.stderr.split('\n').map(part => part.trim()).find(part => part !== '')
  return line ?? `git exited with code ${String(outcome.exitCode)}`
}

/**
 * Turn a non-zero exit into the right classified failure.
 * @param outcome - the finished command.
 * @returns the failure a caller should return.
 */
function classify(outcome: CommandOutcome): GitFailure {
  if (outcome.timedOut) return fail('timeout', 'git did not finish within gitTimeoutMs')
  if (outcome.aborted) return fail('cancelled', 'the request was abandoned before git finished')
  const message = stderrLine(outcome)
  if (/not a git repository/iu.test(message)) return fail('not-a-repository', message)
  return fail('git-failed', message)
}

/** A resolved repository: where git says its root is, and where the request pointed. */
interface Repository {
  /** Absolute repository root. */
  readonly root: string
  /** Requested directory relative to {@link root}, POSIX, empty at the root itself. */
  readonly prefix: string
}

/**
 * Reads one workspace's git state. One instance serves every request; the resolved `git` path is
 * cached across calls and dropped whenever a lookup fails, so installing git later needs no restart.
 */
export class GitReader {
  private executable: string | undefined
  private version: string | undefined

  /**
   * @param ctx - Host context carrying the subprocess and filesystem capabilities.
   * @param source - reads the current settings section; called per request so a committed change
   * reaches the next reading with no registration to rebuild.
   */
  constructor(private readonly ctx: Context, private readonly source: () => AdvancedSidebarSettings) {}

  /**
   * Report whether git can answer on this Host.
   * @param signal - cancellation for the lookup.
   * @returns availability plus the version string when one was read.
   */
  async describe(signal?: AbortSignal): Promise<CapabilityState> {
    let executable: string | undefined
    try {
      executable = await this.locate(signal)
    } catch (error) {
      /* v8 ignore next -- only a missing subprocess capability reaches here. */
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (executable === undefined) {
      return { available: false, reason: 'git is not installed, or not on this Host process PATH' }
    }
    return {
      available: true,
      ...this.version === undefined ? {} : { detail: this.version },
    }
  }

  /**
   * Read one workspace's changed paths.
   * @param request - the workspace directory to read.
   * @param signal - cancellation for the reading.
   * @returns the reading, or a classified failure.
   */
  async status(request: GitStatusRequest, signal?: AbortSignal): Promise<GitStatusResult> {
    const prepared = await this.prepare(request.workspacePath, signal)
    if ('failure' in prepared) return prepared.failure
    const { repository, workspace } = prepared

    const outcome = await this.git(
      workspace.value.processPath,
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all', ...NUL_ARGS],
      signal,
    )
    if (outcome.exitCode !== 0) return classify(outcome)

    const parsed = parsePorcelainV2(outcome.stdout)
    const limit = this.source().gitMaxFiles
    const truncated = parsed.changes.length > limit
    const changes = truncated ? parsed.changes.slice(0, limit) : parsed.changes
    const conflicted = changes.filter(change => change.conflicted)
    return {
      ok: true,
      repositoryRoot: repository.root,
      prefix: repository.prefix,
      ...parsed.branch.branch === undefined ? {} : { branch: parsed.branch.branch },
      ...parsed.branch.upstream === undefined ? {} : { upstream: parsed.branch.upstream },
      ahead: parsed.branch.ahead,
      behind: parsed.branch.behind,
      detached: parsed.branch.detached,
      staged: changes.filter(isStaged),
      unstaged: changes.filter(isUnstaged),
      untracked: changes.filter((change: GitFileChange) => change.untracked),
      conflicted,
      truncated,
      readAt: Date.now(),
    }
  }

  /**
   * Read one path's patch.
   * @param request - which path, and which of the two indexes to compare.
   * @param signal - cancellation for the reading.
   * @returns the patch, or a classified failure.
   */
  async diff(request: GitDiffRequest, signal?: AbortSignal): Promise<GitDiffResult> {
    const prepared = await this.prepare(request.workspacePath, signal)
    if ('failure' in prepared) return prepared.failure
    const { repository } = prepared

    // `--` and a repository-relative path, never a pattern: a path from the browser must not be
    // able to become an option (`--output=…`) or a pathspec magic word.
    const common = ['--no-pager', 'diff', '--no-color', '--no-ext-diff']
    const argv = request.untracked
      // An untracked path has no index entry to compare against, so the empty blob stands in for
      // the left side. `--no-index` makes git compare two paths directly and exit 1 on difference.
      ? [...common, '--no-index', '--', devNull(), request.path]
      : [...common, ...request.staged ? ['--cached'] : [], '--', request.path]

    const outcome = await this.git(repository.root, argv, signal)
    // `git diff` exits 1 when it found a difference under `--no-index`; only anything else is an error.
    if (outcome.exitCode !== 0 && !(request.untracked && outcome.exitCode === 1)) {
      return classify(outcome)
    }
    const max = this.source().gitDiffMaxBytes
    const patch = outcome.stdout
    const truncated = patch.length > max
    return {
      ok: true,
      path: request.path,
      patch: truncated ? patch.slice(0, max) : patch,
      binary: /^Binary files .* differ$/mu.test(patch),
      truncated,
    }
  }

  /**
   * Resolve the workspace and its repository once for both endpoints.
   * @param workspacePath - the browser-supplied directory.
   * @param signal - cancellation for the resolution and the `rev-parse`.
   * @returns the repository and the resolved workspace, or the failure to return.
   */
  private async prepare(workspacePath: string, signal?: AbortSignal): Promise<
    { repository: Repository; workspace: Extract<PathOutcome, { ok: true }> } | { failure: GitFailure }
  > {
    const workspace = await resolveWorkspace(this.ctx, workspacePath, signal)
    if (!workspace.ok) return { failure: fail(workspace.rejection.code, workspace.rejection.message) }
    const repository = await this.locateRepository(workspace.value.processPath, signal)
    if ('failure' in repository) return { failure: repository.failure }
    return { repository: repository.repository, workspace }
  }

  /**
   * Ask git where the repository containing a directory begins.
   * @param cwd - the canonical workspace directory.
   * @param signal - cancellation for the invocation.
   * @returns the repository, or the failure to return.
   */
  private async locateRepository(
    cwd: string, signal?: AbortSignal,
  ): Promise<{ repository: Repository } | { failure: GitFailure }> {
    const outcome = await this.git(cwd, ['rev-parse', '--show-toplevel', '--show-prefix'], signal)
    if (outcome.exitCode !== 0) return { failure: classify(outcome) }
    const [root, prefix] = outcome.stdout.split('\n')
    if (root === undefined || root.trim() === '') {
      return { failure: fail('not-a-repository', `${cwd} is not inside a git repository`) }
    }
    // `--show-prefix` prints a trailing slash, which no path in the status output carries.
    return { repository: { root: root.trim(), prefix: (prefix ?? '').trim().replace(/\/$/u, '') } }
  }

  /**
   * Run one git invocation with this plugin's own bounds.
   * @param cwd - directory to run in.
   * @param args - arguments after the executable.
   * @param signal - the caller's cancellation.
   * @returns the finished command.
   */
  private async git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<CommandOutcome> {
    const executable = await this.locate(signal)
    if (executable === undefined) {
      // `locate` already returned undefined for a missing binary, and every caller classifies a
      // non-zero exit, so a synthetic outcome keeps one return path instead of two.
      return {
        exitCode: 127, signal: null, stdout: '',
        stderr: 'git is not installed, or not on this Host process PATH',
        timedOut: false, aborted: false,
      }
    }
    const settings = this.source()
    return runCommand(this.ctx, {
      argv: [executable, ...args],
      cwd,
      timeoutMs: settings.gitTimeoutMs,
      maxBytes: Math.max(settings.gitDiffMaxBytes, 1 << 20),
      // git needs no grace period of its own: it holds no children and exits on TERM.
      graceMs: 1_000,
      // A pager would never exit, and locale-dependent output would break the parsers.
      env: { GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }, signal)
  }

  /**
   * Resolve `git` once and remember it.
   * @param signal - cancellation for the lookup.
   * @returns the executable path, or undefined when git is absent.
   * @throws {CommandUnavailableError} when no subprocess capability is mounted.
   */
  private async locate(signal?: AbortSignal): Promise<string | undefined> {
    if (this.executable !== undefined) return this.executable
    const found = await resolveCommand(this.ctx, 'git', signal)
    if (found === undefined) return undefined
    this.executable = found
    // Version is a diagnostic, so a failure to read it must not make git look absent.
    try {
      const outcome = await runCommand(this.ctx, {
        argv: [found, '--version'], cwd: process.cwd(), timeoutMs: 5_000, maxBytes: 4_096, graceMs: 1_000,
      }, signal)
      if (outcome.exitCode === 0) this.version = outcome.stdout.trim()
    } catch (error) {
      /* v8 ignore next -- runCommand only throws for a withdrawn subprocess capability. */
      if (!(error instanceof CommandUnavailableError)) throw error
    }
    return found
  }
}

/**
 * The empty left-hand side of an untracked file's synthesized patch.
 * @returns the platform's null device path.
 */
function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}
