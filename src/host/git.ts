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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isStaged, isUnstaged, parsePorcelainV2 } from './porcelain.ts'
import { resolveInside, resolveWorkspace, type PathOutcome } from './paths.ts'
import { CommandUnavailableError, resolveCommand, runCommand, type CommandOutcome } from './run.ts'
import type {
  AdvancedSidebarSettings, CapabilityState, GitCommitMessageRequest, GitCommitMessageResult,
  GitCommitRequest, GitCommitResult, GitDiffRequest, GitDiffResult, GitFailure, GitFailureCode,
  GitFileChange, GitPushRequest, GitPushResult, GitStageRequest, GitStageResult, GitStatusRequest,
  GitStatusResult, GitStatusSuccess, GitWriteCapability,
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

/** The remote a branch with no upstream is published to when nothing else names one. */
const DEFAULT_REMOTE = 'origin'

/**
 * Configuration every invocation carries, ahead of the subcommand.
 *
 * `core.fsmonitor` names an executable git runs whenever it refreshes the index — which `status`,
 * `diff`, `add` and `commit` all do — and it is read from the repository's own `.git/config`. A
 * workspace whose config was written by someone else (an unpacked archive, a shared directory) would
 * otherwise run their program the moment the Changes panel opened. The monitor is only a speed-up, so
 * turning it off costs a slower status on a very large repository and nothing else. `-c` on the command
 * line outranks every config file, and git passes it on to the child gits it starts (submodules).
 */
const INVOCATION_CONFIG = ['-c', 'core.fsmonitor=false'] as const

/**
 * Flags every `git diff` carries, so a patch is git's own rendering and never a configured program's.
 *
 * `--no-ext-diff` refuses `diff.external` and per-attribute `diff.<driver>.command`; `--no-textconv`
 * refuses `diff.<driver>.textconv`. Both name executables from repository config and attributes, and
 * both would otherwise run on a reading nobody asked to be a command.
 */
const DIFF_SAFETY_ARGS = ['--no-ext-diff', '--no-textconv'] as const

/**
 * Config keys that name a content filter's executable.
 *
 * `filter.<driver>.clean` (and the long-running `process` protocol) run when git hashes a working-tree
 * file — which `git status` does for every file whose stat data changed. A driver is attached by
 * `.gitattributes`, which a repository ships, and defined in config, which is where the executable
 * comes from; `smudge` runs only on checkout, which no reading here performs.
 */
const FILTER_EXECUTABLE_KEYS = String.raw`^filter\..*\.(clean|process)$`

/** The key shape one filter listing line carries, split into its driver name and its variable. */
const FILTER_KEY = /^filter\.(.+)\.(clean|process)$/u

/**
 * Config scopes whose filter programs a reading may run.
 *
 * `system` and `global` are files the operator (or their administrator) wrote, and they are where
 * `git lfs install` puts its filter, so neutralizing them would turn every LFS file into a phantom
 * change. `local` and `worktree` live inside the repository's own `.git`, which is exactly the
 * config a workspace can arrive with.
 */
const TRUSTED_CONFIG_SCOPES = new Set(['system', 'global'])

/** `git config --get-regexp` exits 1 to mean "no key matched", which is an ordinary answer. */
const CONFIG_NO_MATCH_EXIT = 1

/**
 * What the model is told a commit message is, when the settings section supplies no prompt of its
 * own.
 *
 * It states the format because a model asked for "a commit message" writes a paragraph as readily
 * as a subject line, and the panel puts the answer straight into the box a person then edits.
 */
const DEFAULT_COMMIT_PROMPT = [
  'Write a git commit message for the supplied diff.',
  'Answer with the message alone: no preamble, no explanation, no code fences, no quotes.',
  'First line: imperative mood, under 72 characters, no trailing period.',
  'Then, only if the change needs it, a blank line and a short body explaining WHY rather than'
  + ' restating the diff. Wrap the body at 72 columns.',
  'Describe what the diff actually does. Do not invent a motive it does not show.',
].join('\n')

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

/**
 * Take a model's answer down to the message itself.
 *
 * A model asked for plain text still fences it often enough that the panel would otherwise put
 * ```` ``` ```` into a commit; the wrapper is removed only when it wraps the WHOLE answer, so a
 * message that legitimately quotes a fenced block keeps it.
 * @param text - what the model streamed.
 * @returns the message, trimmed.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/u.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}

/** A resolved repository: where git says its root is, and where the request pointed. */
interface Repository {
  /** Absolute repository root. */
  readonly root: string
  /** Requested directory relative to {@link root}, POSIX, empty at the root itself. */
  readonly prefix: string
  /**
   * `-c` pairs that switch off every content filter the repository's own config defines, for the
   * readings; see {@link FILTER_EXECUTABLE_KEYS}. Empty when it defines none.
   */
  readonly readingConfig: readonly string[]
}

/**
 * The `-c` overrides that disarm the untrusted filter programs one config listing names.
 *
 * An empty value is git's own "no command" for a filter (`convert.c` runs a driver only when its
 * command is non-empty), so the file is then hashed as its bytes, exactly as with no driver at all.
 * @param listing - `git config --show-scope --name-only --get-regexp` output, one `scope<TAB>key` per
 * line; a line with no scope (an older git) is treated as untrusted.
 * @returns the overrides, or the key git could not be told about safely.
 */
export function filterOverrides(listing: string): { readonly config: readonly string[] } | { readonly unsafeKey: string } {
  const config: string[] = []
  for (const line of listing.split('\n')) {
    if (line.trim() === '') continue
    const tab = line.indexOf('\t')
    const scope = tab < 0 ? undefined : line.slice(0, tab)
    const key = tab < 0 ? line : line.slice(tab + 1)
    if (scope !== undefined && TRUSTED_CONFIG_SCOPES.has(scope)) continue
    // `-c name=value` splits at the FIRST `=`, so a driver named `a=b` cannot be addressed by it: the
    // override would name a different key and leave the real one armed. Refusing is the only
    // answer that does not guess.
    if (key.includes('=') || FILTER_KEY.exec(key) === null) return { unsafeKey: key }
    config.push('-c', `${key}=`)
  }
  return { config }
}

/**
 * Whether a name could be read as an option by a git command it is passed to.
 * @param name - a branch or remote name taken from repository state.
 * @returns true when it begins with `-`.
 */
function isOptionShaped(name: string): boolean {
  return name.startsWith('-')
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

    const outcome = await this.read(
      repository,
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all', ...NUL_ARGS],
      signal,
      undefined,
      workspace.value.processPath,
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
      write: await this.writeCapability(repository, signal),
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
    const common = ['--no-pager', 'diff', '--no-color', ...DIFF_SAFETY_ARGS]
    const argv = request.untracked
      // An untracked path has no index entry to compare against, so the empty blob stands in for
      // the left side. `--no-index` makes git compare two paths directly and exit 1 on difference.
      ? [...common, '--no-index', '--', devNull(), request.path]
      : [...common, ...request.staged ? ['--cached'] : [], '--', request.path]

    const max = this.source().gitDiffMaxBytes
    const outcome = await this.read(repository, argv, signal, max)
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

    if ((await this.author(repository, signal)) === undefined) {
      return fail(
        'no-identity',
        'git has no user.name and user.email, so it has no author to record;'
        + ' set them with `git config --global user.name` and `git config --global user.email`',
      )
    }
    // Amending has something to record even with an empty index, so the guard applies only to an
    // ordinary commit — where git's own refusal is a long paragraph about how to stage things.
    if (!request.amend && !(await this.hasStaged(repository, signal))) {
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

    const described = await this.read(repository, ['log', '-1', '--format=%h%n%s'], signal)
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
   * Send the current branch's commits to its remote.
   *
   * Only the current branch, and only to its own upstream: a refspec assembled from browser text
   * would let one button push anything anywhere, and `git push` with no arguments already means
   * exactly what the panel offers. A branch with no upstream is published only when the caller asks
   * for it, because choosing a remote is a decision rather than a default.
   * @param request - the workspace, and whether an unpublished branch may be published.
   * @param signal - cancellation; the network wait runs under `gitPushTimeoutMs`.
   * @returns the push, the reading after it, or a classified failure.
   */
  async push(request: GitPushRequest, signal?: AbortSignal): Promise<GitPushResult> {
    const settings = this.source()
    if (!settings.allowGitPush) {
      return fail('disabled', 'pushing is switched off in the advanced-sidebar settings')
    }
    const prepared = await this.prepare(request.workspacePath, signal)
    if ('failure' in prepared) return prepared.failure
    const { repository } = prepared

    const before = await this.status({ workspacePath: request.workspacePath }, signal)
    if (!before.ok) return before
    if (before.detached || before.branch === undefined) {
      return fail('detached-head', 'HEAD names a commit rather than a branch, so there is nothing to push')
    }
    const branch = before.branch
    const upstream = before.upstream
    if (upstream === undefined && !request.setUpstream) {
      return fail(
        'no-upstream',
        `${branch} has no upstream; publish it to a remote first, or use Publish to record one`,
      )
    }
    // The remote half of `origin/main`, so a branch tracking something other than `origin` is
    // published to the remote it already follows rather than to a guess.
    const remote = upstream === undefined
      ? await this.defaultRemote(repository, signal)
      : (upstream.split('/')[0] ?? DEFAULT_REMOTE)
    if (remote === undefined) {
      return fail('no-upstream', 'this repository has no remote to push to')
    }
    const argv = upstream === undefined
      ? await this.publishArgv(repository, remote, branch, signal)
      : { argv: ['push'] }
    if ('failure' in argv) return argv.failure

    const outcome = await this.git(repository.root, argv.argv, signal, undefined, settings.gitPushTimeoutMs)
    if (outcome.exitCode !== 0) return classify(outcome)

    const status = await this.status({ workspacePath: request.workspacePath }, signal)
    if (!status.ok) return status
    return {
      ok: true,
      branch,
      remote,
      published: upstream === undefined,
      status,
      // git reports a push on stderr even when it succeeds; that text is the receipt.
      notes: `${outcome.stdout}\n${outcome.stderr}`.trim(),
    }
  }

  /**
   * The arguments that publish one branch to one remote and record it as the upstream.
   *
   * Both names come from repository state, not from the browser — and repository state is not
   * trusted either. A HEAD of `refs/heads/--receive-pack=/tmp/x` is a valid ref (`check-ref-format`
   * accepts it) that `git status` reports as the branch `--receive-pack=/tmp/x`; handed to
   * `git push` as a bare argument, git parsed it as the option and ran `/tmp/x` as the remote's
   * receive-pack. So three independent things stand in the way:
   *
   * 1. Both names are refused outright when they begin with `-`.
   * 2. The branch must pass `git check-ref-format --branch`, which is git's own branch-name grammar
   *    (it rejects a leading `-`, `..`, control characters, `@{`) and must echo back unchanged, so a
   *    `@{-1}` shorthand cannot be expanded into some other branch. The remote must make a valid
   *    remote-tracking ref, which is how git itself validates a remote name.
   * 3. The push names the refs after `--`, where `git push` (parse-options) stops reading options,
   *    and as a fully qualified `refs/heads/<b>:refs/heads/<b>` refspec, which also cannot be read as
   *    a shorter ref with the same name on the remote. `--set-upstream` records the same tracking
   *    branch it records for the short spelling.
   * @param repository - the resolved repository.
   * @param remote - the remote to publish to, from `git remote`.
   * @param branch - the current branch, from `git status`.
   * @param signal - cancellation for the validation invocations.
   * @returns the push arguments, or the failure to return.
   */
  private async publishArgv(
    repository: Repository, remote: string, branch: string, signal?: AbortSignal,
  ): Promise<{ argv: readonly string[] } | { failure: GitFailure }> {
    if (isOptionShaped(branch) || !(await this.isValidBranchName(repository, branch, signal))) {
      return { failure: fail('git-failed', `refusing to publish: ${JSON.stringify(branch)} is not a valid branch name`) }
    }
    if (isOptionShaped(remote) || !(await this.isValidRemoteName(repository, remote, signal))) {
      return { failure: fail('git-failed', `refusing to publish: ${JSON.stringify(remote)} is not a valid remote name`) }
    }
    const ref = `refs/heads/${branch}`
    return { argv: ['push', '--set-upstream', '--', remote, `${ref}:${ref}`] }
  }

  /**
   * Whether git accepts a name as a branch name, spelled exactly as given.
   * @param repository - the resolved repository.
   * @param branch - the name, already known not to begin with `-`.
   * @param signal - cancellation for the invocation.
   * @returns true when `check-ref-format --branch` accepts it and echoes it back unchanged.
   */
  private async isValidBranchName(repository: Repository, branch: string, signal?: AbortSignal): Promise<boolean> {
    // `--branch` consumes the next argument as the name whatever it looks like, and the leading `-`
    // was refused before this runs.
    const outcome = await this.read(repository, ['check-ref-format', '--branch', branch], signal)
    return outcome.exitCode === 0 && outcome.stdout.replace(/\n$/u, '') === branch
  }

  /**
   * Whether git accepts a name as a remote name.
   * @param repository - the resolved repository.
   * @param remote - the name, already known not to begin with `-`.
   * @param signal - cancellation for the invocation.
   * @returns true when `refs/remotes/<remote>/HEAD` is a well-formed ref, git's own remote-name rule.
   */
  private async isValidRemoteName(repository: Repository, remote: string, signal?: AbortSignal): Promise<boolean> {
    // A fully qualified refname begins with `refs/`, so this argument can never read as an option.
    const outcome = await this.read(repository, ['check-ref-format', `refs/remotes/${remote}/HEAD`], signal)
    return outcome.exitCode === 0
  }

  /**
   * Ask the deployment's own model to write a commit message for what is staged.
   *
   * The model sees the staged patch and nothing else — not the working tree, not the repository's
   * history, not the session. It is the same model the composer is set to, so this needs no second
   * credential and no second provider; a Host with no model reports the verb unavailable instead.
   * @param request - the workspace, and whether the message is for an amend.
   * @param signal - cancellation for the readings and the model call.
   * @returns the drafted message, or a classified failure.
   */
  async draftCommitMessage(
    request: GitCommitMessageRequest, signal?: AbortSignal,
  ): Promise<GitCommitMessageResult> {
    const settings = this.source()
    if (!settings.allowGitCommit || !settings.allowCommitMessageDraft) {
      return fail('disabled', 'the drafted commit message is switched off in the advanced-sidebar settings')
    }
    const llm = this.ctx.get('llm')
    const models = this.ctx.get('agentDefaultModel')
    if (llm === undefined || models === undefined) {
      return fail('no-model', 'no model is configured for this deployment')
    }
    const prepared = await this.prepare(request.workspacePath, signal)
    if ('failure' in prepared) return prepared.failure
    const { repository } = prepared

    const patch = await this.stagedPatch(repository, request.amend, signal)
    if ('failure' in patch) return patch.failure
    if (patch.text.trim() === '') {
      return fail('nothing-staged', 'nothing is staged, so there is nothing to describe')
    }

    const selection = models.currentSelection()
    try {
      let drafted = ''
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        system: settings.commitMessagePrompt.trim() === ''
          ? DEFAULT_COMMIT_PROMPT
          : settings.commitMessagePrompt,
        messages: [createUserMessage({
          content: [{ type: 'text', text: patch.text }],
          source: { kind: 'plugin', plugin: 'dsh-advanced-sidebar' },
        })],
        ...signal === undefined ? {} : { signal },
      })) {
        if (chunk.type === 'text-delta') drafted += chunk.text
      }
      const message = stripFence(drafted)
      if (message === '') return fail('llm-failed', 'the model returned no message')
      return { ok: true, message, model: `${selection.provider}/${selection.model}`, truncated: patch.truncated }
    } catch (error) {
      if (signal?.aborted === true) return fail('cancelled', 'the request was abandoned')
      return fail('llm-failed', error instanceof Error ? error.message : 'the model request failed')
    }
  }

  /**
   * The patch a drafted message describes, bounded so a large change cannot become a large request.
   * @param repository - the resolved repository.
   * @param amend - describe the previous commit's content as well as the index.
   * @param signal - cancellation for the invocations.
   * @returns the patch and whether it was cut, or the failure to return.
   */
  private async stagedPatch(
    repository: Repository, amend: boolean, signal?: AbortSignal,
  ): Promise<{ text: string; truncated: boolean } | { failure: GitFailure }> {
    const settings = this.source()
    // An amend replaces the previous commit, so what it will contain is the index measured against
    // that commit's PARENT. A root commit has no parent, and its own index is the whole answer.
    const base = amend && await this.hasParent(repository, signal) ? ['HEAD~1'] : []
    const stat = await this.read(repository, ['diff', ...DIFF_SAFETY_ARGS, '--cached', '--stat', ...base], signal)
    if (stat.exitCode !== 0) return { failure: classify(stat) }
    const cap = settings.commitMessageMaxBytes
    const patch = await this.read(
      repository, ['diff', ...DIFF_SAFETY_ARGS, '--cached', '--no-color', ...base], signal, cap,
    )
    if (patch.exitCode !== 0) return { failure: classify(patch) }
    const truncated = patch.stdoutLossy || patch.stdout.length >= cap
    return {
      text: [
        stat.stdout.trim(),
        '',
        truncated ? patch.stdout.slice(0, cap) : patch.stdout,
        truncated ? '\n[the patch was truncated here]' : '',
      ].join('\n').trim(),
      truncated,
    }
  }

  /**
   * Whether HEAD has a parent commit.
   * @param repository - the resolved repository.
   * @param signal - cancellation for the invocation.
   * @returns true when `HEAD~1` resolves.
   */
  private async hasParent(repository: Repository, signal?: AbortSignal): Promise<boolean> {
    const outcome = await this.read(repository, ['rev-parse', '--verify', '--quiet', 'HEAD~1'], signal)
    return outcome.exitCode === 0
  }

  /**
   * The remote an unpublished branch would be published to.
   * @param repository - the resolved repository.
   * @param signal - cancellation for the invocation.
   * @returns `origin` when it exists, else the first remote, else undefined.
   */
  private async defaultRemote(repository: Repository, signal?: AbortSignal): Promise<string | undefined> {
    const outcome = await this.read(repository, ['remote'], signal)
    if (outcome.exitCode !== 0) return undefined
    const remotes = outcome.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    return remotes.includes(DEFAULT_REMOTE) ? DEFAULT_REMOTE : remotes[0]
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
   * @param repository - the resolved repository.
   * @param signal - cancellation for the invocation.
   * @returns `Name <email>`, or undefined when git has no identity configured.
   */
  private async author(repository: Repository, signal?: AbortSignal): Promise<string | undefined> {
    // `var GIT_AUTHOR_IDENT` is git's own answer to "who would this commit be by", and it fails
    // exactly when a commit would — rather than checking two config keys and guessing at the rules
    // that combine them.
    const outcome = await this.read(repository, ['var', 'GIT_AUTHOR_IDENT'], signal)
    if (outcome.exitCode !== 0) return undefined
    // `Name <email> 1700000000 +0000` — the timestamp is git's, not the identity.
    const ident = outcome.stdout.trim()
    const at = ident.lastIndexOf('>')
    return at < 0 ? undefined : ident.slice(0, at + 1)
  }

  /**
   * Whether the index differs from HEAD.
   * @param repository - the resolved repository.
   * @param signal - cancellation for the invocation.
   * @returns true when a commit would record something.
   */
  private async hasStaged(repository: Repository, signal?: AbortSignal): Promise<boolean> {
    // `diff --cached --quiet` exits 1 when there IS a difference, which is the whole test. On an
    // unborn branch there is no HEAD to compare against, and git exits non-zero there too — which
    // is the right answer, because the first commit records whatever is in the index.
    const outcome = await this.read(repository, ['diff', ...DIFF_SAFETY_ARGS, '--cached', '--quiet'], signal)
    return outcome.exitCode !== 0
  }

  /**
   * Report what the panel may do to this repository.
   * @param repository - the resolved repository.
   * @param signal - cancellation for the identity lookup.
   * @returns the write capability.
   */
  private async writeCapability(repository: Repository, signal?: AbortSignal): Promise<GitWriteCapability> {
    const settings = this.source()
    const canStage = settings.allowGitStaging
    // Commit without staging would be a button with no way to fill the index it needs.
    const canCommit = canStage && settings.allowGitCommit
    // A drafted message is a message for a commit, so it follows the commit verb; the model is a
    // second requirement, and one this Host may simply not have.
    const canDraftMessage = canCommit
      && settings.allowCommitMessageDraft
      && this.ctx.get('llm') !== undefined
      && this.ctx.get('agentDefaultModel') !== undefined
    const author = canCommit ? await this.author(repository, signal) : undefined
    return {
      canStage,
      canCommit,
      canPush: settings.allowGitPush,
      canDraftMessage,
      ...author === undefined ? {} : { author },
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
    const readingConfig = await this.untrustedFilterConfig(root.trim(), signal)
    if ('failure' in readingConfig) return { failure: readingConfig.failure }
    return {
      repository: {
        root: root.trim(),
        // `--show-prefix` prints a trailing slash, which no path in the status output carries.
        prefix: (prefix ?? '').trim().replace(/\/$/u, ''),
        readingConfig: readingConfig.config,
      },
    }
  }

  /**
   * The overrides that switch off the content filters a repository's own config defines.
   *
   * Listing config runs nothing — `git config` reads files — so this is safe to ask before any
   * reading. `--show-scope` arrived in git 2.26; an older git refuses the flag, and the listing is
   * then repeated without it and every filter it names is treated as untrusted, which can only make
   * a reading more conservative. A listing that fails both ways fails the reading: a status that
   * cannot prove its filters are disarmed is not run.
   * @param root - absolute repository root.
   * @param signal - cancellation for the listing.
   * @returns the `-c` pairs, or the failure to return.
   */
  private async untrustedFilterConfig(
    root: string, signal?: AbortSignal,
  ): Promise<{ config: readonly string[] } | { failure: GitFailure }> {
    const scoped = await this.git(
      root, ['config', '--show-scope', '--name-only', '--get-regexp', FILTER_EXECUTABLE_KEYS], signal,
    )
    const listing = isConfigListing(scoped)
      ? scoped
      : await this.git(root, ['config', '--name-only', '--get-regexp', FILTER_EXECUTABLE_KEYS], signal)
    if (!isConfigListing(listing)) return { failure: classify(listing) }
    const overrides = filterOverrides(listing.stdout)
    if ('unsafeKey' in overrides) {
      return {
        failure: fail(
          'git-failed',
          `refusing to read this repository: its config defines ${JSON.stringify(overrides.unsafeKey)}, a `
          + 'filter program that cannot be switched off from the command line',
        ),
      }
    }
    return { config: overrides.config }
  }

  /**
   * Run one READING: an invocation the panel makes on its own, which must run no program the
   * repository's config names.
   *
   * On top of {@link git}'s own `core.fsmonitor` override it disarms the repository's content
   * filters. Writes (`add`, `restore`, `commit`, `push`) deliberately do not go through here: they are
   * an operator's explicit action, a filter such as LFS is part of what staging correctly means, and a
   * commit's hooks are a real answer the panel reports.
   * @param repository - the resolved repository, carrying its filter overrides.
   * @param args - arguments after the executable and the overrides.
   * @param signal - the caller's cancellation.
   * @param maxBytes - the caller's own output bound, when it has one.
   * @param cwd - directory to run in; the repository root unless the reading is relative to the workspace.
   * @returns the finished command.
   */
  private read(
    repository: Repository, args: readonly string[], signal?: AbortSignal, maxBytes?: number,
    cwd: string = repository.root,
  ): Promise<CommandOutcome> {
    return this.git(cwd, [...repository.readingConfig, ...args], signal, maxBytes)
  }

  /**
   * Run one git invocation with this plugin's own bounds and {@link INVOCATION_CONFIG}.
   * @param cwd - directory to run in.
   * @param args - arguments after the executable and the invocation config.
   * @param signal - the caller's cancellation.
   * @param maxBytes - the caller's own output bound, when it has one.
   * @param timeoutMs - the caller's own wall-clock bound, when it has one.
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
      argv: [executable, ...INVOCATION_CONFIG, ...args],
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
 * Whether a `git config --get-regexp` finished with a usable answer.
 * @param outcome - the finished listing.
 * @returns true for a listing (exit 0) or for "nothing matched" (exit 1 with a silent stderr).
 */
function isConfigListing(outcome: CommandOutcome): boolean {
  if (outcome.exitCode === 0) return true
  return outcome.exitCode === CONFIG_NO_MATCH_EXIT && outcome.stderr.trim() === ''
}

/**
 * The empty left-hand side of an untracked file's synthesized patch.
 * @returns the platform's null device path.
 */
function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}
