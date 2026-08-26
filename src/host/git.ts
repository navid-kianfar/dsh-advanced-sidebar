/**
 * Git readings for the Changes panel.
 *
 * The harness has no git capability, so this reads a repository the only way available to a plugin:
 * by running `git` through `ctx.subprocess` and parsing its machine formats. Nothing here writes to
 * a repository — the panel shows what changed and what one path's patch looks like, and every
 * argument list is fixed here rather than assembled from browser text.
 * @module @achasoft/dsh-advanced-sidebar/host/git
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isStaged, isUnstaged, parsePorcelainV2 } from './porcelain.ts'
import { resolveInside, resolveWorkspace, type PathOutcome } from './paths.ts'
import { CommandUnavailableError, resolveCommand, runCommand, type CommandOutcome } from './run.ts'
import type {
  AdvancedSidebarSettings, CapabilityState, GitCommitRequest, GitCommitResult, GitDiffRequest,
  GitDiffResult, GitFailure, GitFailureCode, GitFileChange, GitStageRequest, GitStageResult,
  GitStatusRequest, GitStatusResult, GitStatusSuccess, GitWriteCapability,
} from './types.ts'

/**
 * `git`'s own separator between the two paths of a rename record and between status lines.
 * Requested explicitly (`-z`) so a path containing a newline or a quote cannot be misread — git's
 * default output would C-quote such a path and this parser would then compare a quoted spelling
 * against the unquoted one a later diff request repeats.
 */
const NUL_ARGS = ['-z'] as const

/** Exit code of the synthetic outcome produced when the `git` binary does not resolve. */
const MISSING_BINARY_EXIT = 127

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
  // 127 is the synthetic outcome `git()` produces for an unresolvable binary; a real git never
  // exits with it, and reporting it as `git-failed` would send a person hunting a repository fault.
  if (outcome.exitCode === MISSING_BINARY_EXIT) {
    return fail('no-git', 'git is not installed, or not on this Host process PATH')
  }
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
    // `stdoutLossy` means git printed more than the collector kept, so the head of the reading is
    // gone and the list is incomplete however few rows survived parsing.
    const truncated = outcome.stdoutLossy || parsed.changes.length > limit
    const changes = truncated ? parsed.changes.slice(0, limit) : parsed.changes
    const conflicted = changes.filter(change => change.conflicted)
    return {
      ok: true,
      write: await this.writeCapability(repository.root, signal),
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

    const contained = await this.contain(repository.root, [request.path], signal)
    if (contained !== undefined) return contained

    // `--` and a repository-relative path, never a pattern: a path from the browser must not be
    // able to become an option (`--output=…`) or a pathspec magic word.
    const common = ['--no-pager', 'diff', '--no-color', '--no-ext-diff']
    const argv = request.untracked
      // An untracked path has no index entry to compare against, so the empty blob stands in for
      // the left side. `--no-index` makes git compare two paths directly and exit 1 on difference.
      ? [...common, '--no-index', '--', devNull(), request.path]
      : [...common, ...request.staged ? ['--cached'] : [], '--', request.path]

    const max = this.source().gitDiffMaxBytes
    const outcome = await this.git(repository.root, argv, signal, max)
    // `git diff --no-index` exits 1 to mean "the two files differ", which is the ordinary answer
    // here. It also exits 1 for its own usage errors, and those go to stderr — so an exit 1 is
    // success only when git said nothing on stderr.
    const differed = request.untracked && outcome.exitCode === 1 && outcome.stderr.trim() === ''
    if (outcome.exitCode !== 0 && !differed) return classify(outcome)

    const patch = outcome.stdout
    // Two truncations can apply: the collector kept only the tail of an enormous patch, and the cap
    // below keeps only the head. Reporting the union is what stops a patch that is really a middle
    // slice from being labelled complete.
    const truncated = outcome.stdoutLossy || patch.length > max
    return {
      ok: true,
      path: request.path,
      patch: patch.length > max ? patch.slice(0, max) : patch,
      binary: /^Binary files .* differ$/mu.test(patch),
      truncated,
    }
  }

  /**
   * Stage paths.
   * @param request - the workspace and the repository-relative paths to add.
   * @param signal - cancellation for the write and the reading that follows it.
   * @returns the reading after the write, or a classified failure.
   */
  stage(request: GitStageRequest, signal?: AbortSignal): Promise<GitStageResult> {
    if (!this.source().allowGitStaging) {
      return Promise.resolve(fail('disabled', 'staging is switched off in the advanced-sidebar settings'))
    }
    // `--` then literal paths: `add` takes PATHSPECS, so without it a path beginning `:` would be
    // read as pathspec magic (`:(exclude)`, `:/`) and stage something the operator did not pick.
    return this.write(request, signal, paths => ['add', '--', ...paths])
  }

  /**
   * Unstage paths, leaving the working tree untouched.
   * @param request - the workspace and the repository-relative paths to restore.
   * @param signal - cancellation for the write and the reading that follows it.
   * @returns the reading after the write, or a classified failure.
   */
  unstage(request: GitStageRequest, signal?: AbortSignal): Promise<GitStageResult> {
    if (!this.source().allowGitStaging) {
      return Promise.resolve(fail('disabled', 'staging is switched off in the advanced-sidebar settings'))
    }
    // `restore --staged`, not `reset`: it touches the index only, and it is the one spelling that
    // works the same before and after the first commit. `reset HEAD -- <path>` fails on an unborn
    // branch, which is exactly when a person is most likely to be staging by hand.
    return this.write(request, signal, paths => ['restore', '--staged', '--', ...paths])
  }

  /**
   * Record the staged changes.
   *
   * The message crosses as one argv element, so no shell ever sees it and nothing in it can become
   * an option. Hooks run: a `pre-commit` that refuses is a real answer, and its stderr is returned
   * verbatim rather than summarized.
   * @param request - the workspace, the message, and whether to replace the previous commit.
   * @param signal - cancellation for the commit and the reading that follows it.
   * @returns the new commit and the reading after it, or a classified failure.
   */
  async commit(request: GitCommitRequest, signal?: AbortSignal): Promise<GitCommitResult> {
    const settings = this.source()
    if (!settings.allowGitCommit) {
      return fail('disabled', 'committing is switched off in the advanced-sidebar settings')
    }
    const message = request.message.trim()
    if (message === '') return fail('empty-message', 'a commit needs a message')

    const prepared = await this.prepare(request.workspacePath, signal)
    if ('failure' in prepared) return prepared.failure
    const { repository } = prepared

    if ((await this.author(repository.root, signal)) === undefined) {
      return fail(
        'no-identity',
        'git has no user.name and user.email, so it has no author to record;'
        + ' set them with `git config --global user.name` and `git config --global user.email`',
      )
    }
    // Amending has something to record even with an empty index, so the guard applies only to an
    // ordinary commit — where git's own refusal is a long paragraph about how to stage things.
    if (!request.amend && !(await this.hasStaged(repository.root, signal))) {
      return fail('nothing-staged', 'nothing is staged, so there is nothing to commit')
    }

    const outcome = await this.git(
      repository.root,
      ['commit', ...request.amend ? ['--amend'] : [], '-m', message],
      signal,
      undefined,
      settings.gitCommitTimeoutMs,
    )
    if (outcome.exitCode !== 0) return classify(outcome)

    const described = await this.git(repository.root, ['log', '-1', '--format=%h%n%s'], signal)
    const [commit, subject] = described.stdout.split('\n')
    const status = await this.status({ workspacePath: request.workspacePath }, signal)
    if (!status.ok) return status
    return {
      ok: true,
      commit: (commit ?? '').trim(),
      subject: (subject ?? '').trim(),
      status,
      notes: outcome.stderr.trim(),
    }
  }

  /**
   * Run one index write over contained paths, then re-read the repository.
   * @param request - the workspace and the paths.
   * @param signal - cancellation for both invocations.
   * @param argv - builds the git arguments from the accepted paths.
   * @returns the reading after the write, or a classified failure.
   */
  private async write(
    request: GitStageRequest,
    signal: AbortSignal | undefined,
    argv: (paths: readonly string[]) => readonly string[],
  ): Promise<GitStageResult> {
    if (request.paths.length === 0) return fail('path-denied', 'no paths were given')
    const prepared = await this.prepare(request.workspacePath, signal)
    if ('failure' in prepared) return prepared.failure
    const { repository } = prepared

    const contained = await this.contain(repository.root, request.paths, signal)
    if (contained !== undefined) return contained

    const outcome = await this.git(repository.root, argv(request.paths), signal)
    if (outcome.exitCode !== 0) return classify(outcome)
    // The reading rides the same response: a panel that had to ask again would show the old lists
    // for a round trip, and a person clicking Stage twice in that window would stage nothing.
    const status = await this.status({ workspacePath: request.workspacePath }, signal)
    return status.ok ? { ok: true, status } : status
  }

  /**
   * Prove every path sits inside the repository before git is handed any of them.
   *
   * A path from the browser is untrusted input at a process boundary. `git add` and
   * `git restore` both accept absolute paths and `..`, and `git diff --no-index` will read any file
   * at all — so an unchecked path is a write outside the repository in one direction and an
   * exfiltration route in the other.
   * @param root - absolute repository root.
   * @param paths - repository-relative paths, as the browser sent them.
   * @param signal - cancellation for the resolutions.
   * @returns the failure to return, or undefined when every path is inside.
   */
  private async contain(
    root: string, paths: readonly string[], signal?: AbortSignal,
  ): Promise<GitFailure | undefined> {
    const resolved = await resolveWorkspace(this.ctx, root, signal)
    if (!resolved.ok) return fail(resolved.rejection.code, resolved.rejection.message)
    for (const path of paths) {
      // `resolve`, not `join`: joining a root with an ABSOLUTE path re-roots it under the
      // repository (`join('/repo', '/etc/hosts')` is `/repo/etc/hosts`), so the check would pass
      // and git would then be handed the original `/etc/hosts` anyway. `resolve` keeps an absolute
      // path absolute, which is exactly what the check needs to see.
      const inside = await resolveInside(this.ctx, resolved.value, resolve(root, path), signal)
      if (!inside.ok) return fail(inside.rejection.code, inside.rejection.message)
    }
    return undefined
  }

  /**
   * The author `git commit` would record.
   * @param cwd - the repository root.
   * @param signal - cancellation for the invocation.
   * @returns `Name <email>`, or undefined when git has no identity configured.
   */
  private async author(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    // `var GIT_AUTHOR_IDENT` is git's own answer to "who would this commit be by", and it fails
    // exactly when a commit would — rather than checking two config keys and guessing at the rules
    // that combine them.
    const outcome = await this.git(cwd, ['var', 'GIT_AUTHOR_IDENT'], signal)
    if (outcome.exitCode !== 0) return undefined
    // `Name <email> 1700000000 +0000` — the timestamp is git's, not the identity.
    const ident = outcome.stdout.trim()
    const at = ident.lastIndexOf('>')
    return at < 0 ? undefined : ident.slice(0, at + 1)
  }

  /**
   * Whether the index differs from HEAD.
   * @param cwd - the repository root.
   * @param signal - cancellation for the invocation.
   * @returns true when a commit would record something.
   */
  private async hasStaged(cwd: string, signal?: AbortSignal): Promise<boolean> {
    // `diff --cached --quiet` exits 1 when there IS a difference, which is the whole test. On an
    // unborn branch there is no HEAD to compare against, and git exits non-zero there too — which
    // is the right answer, because the first commit records whatever is in the index.
    const outcome = await this.git(cwd, ['diff', '--cached', '--quiet'], signal)
    return outcome.exitCode !== 0
  }

  /**
   * Report what the panel may do to this repository.
   * @param cwd - the repository root.
   * @param signal - cancellation for the identity lookup.
   * @returns the write capability.
   */
  private async writeCapability(cwd: string, signal?: AbortSignal): Promise<GitWriteCapability> {
    const settings = this.source()
    const canStage = settings.allowGitStaging
    // Commit without staging would be a button with no way to fill the index it needs.
    const canCommit = canStage && settings.allowGitCommit
    const author = canCommit ? await this.author(cwd, signal) : undefined
    return { canStage, canCommit, ...author === undefined ? {} : { author } }
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
  private async git(
    cwd: string, args: readonly string[], signal?: AbortSignal, maxBytes?: number, timeoutMs?: number,
  ): Promise<CommandOutcome> {
    const executable = await this.locate(signal)
    if (executable === undefined) {
      // `locate` already returned undefined for a missing binary, and every caller classifies a
      // non-zero exit, so a synthetic outcome keeps one return path instead of two.
      return {
        exitCode: MISSING_BINARY_EXIT, signal: null, stdout: '',
        stderr: 'git is not installed, or not on this Host process PATH',
        timedOut: false, aborted: false, stdoutLossy: false,
      }
    }
    const settings = this.source()
    return runCommand(this.ctx, {
      argv: [executable, ...args],
      cwd,
      timeoutMs: timeoutMs ?? settings.gitTimeoutMs,
      // The caller's own bound where it has one, so the collector and the endpoint truncate at the
      // same place; a status reading gets room for a very large repository.
      maxBytes: maxBytes ?? Math.max(settings.gitDiffMaxBytes, 1 << 20),
      // git needs no grace period of its own: it holds no children and exits on TERM.
      graceMs: 1_000,
      // A pager would never exit, and locale-dependent output would break the parsers.
      env: {
        GIT_PAGER: 'cat',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        // A commit with no `-m` would open an editor and hang until the timeout; `true` makes git
        // fail immediately instead. Every commit here passes `-m`, so this only ever fires for a
        // hook that tries to open one.
        GIT_EDITOR: 'true',
        GIT_TERMINAL_PROMPT: '0',
      },
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
