import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { GitReader, filterOverrides } from '../src/host/git.ts'
import type { AdvancedSidebarSettings } from '../src/host/types.ts'

/**
 * A repository's own `.git/config` is not trusted to run programs, and a branch name out of its HEAD
 * is not trusted to be a branch name. Both were reproduced as live exploits against the Changes
 * panel: `core.fsmonitor` ran on opening it, and Publish on a HEAD of
 * `refs/heads/--receive-pack=<script>` ran the script.
 *
 * These run REAL git against temporary repositories, through a `ctx` whose filesystem and subprocess
 * are thin adapters over Node's own. A fake git would only prove the argv this module builds; the
 * question here is what git actually executes with it, and only git can answer that. Each hostile
 * program writes a marker file, and the assertion is whether the marker exists.
 *
 * Git's global and system config are pinned (`GIT_CONFIG_GLOBAL` to a file this suite writes,
 * `GIT_CONFIG_NOSYSTEM`) so the operator's own config can neither mask a failure nor cause one.
 */

/** The settings fields the readings and writes touch. */
const SETTINGS = {
  gitMaxFiles: 1_000, gitDiffMaxBytes: 1 << 20, gitTimeoutMs: 20_000, gitCommitTimeoutMs: 20_000,
  gitPushTimeoutMs: 20_000, allowGitStaging: true, allowGitCommit: true, allowGitPush: true,
  allowCommitMessageDraft: false, commitMessagePrompt: '', commitMessageMaxBytes: 65_536,
} as unknown as AdvancedSidebarSettings

/** One test's scratch world. */
interface World {
  /** Canonical scratch directory holding the repositories, the scripts and the markers. */
  readonly root: string
  /** The global config file git is pointed at. */
  readonly globalConfig: string
  /** The environment every git invocation, the suite's own included, runs under. */
  readonly env: NodeJS.ProcessEnv
}

let world: World

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-')))
  const globalConfig = join(root, 'global.gitconfig')
  writeFileSync(globalConfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n')
  world = {
    root,
    globalConfig,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }
})

afterEach(() => {
  rmSync(world.root, { recursive: true, force: true })
})

/** Run git for the suite's own setup, outside the code under test. */
function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', args, { cwd, env: world.env, encoding: 'utf8' })
}

/**
 * Write an executable that records it ran, then behaves as a harmless stand-in.
 * @param name - the marker and script base name.
 * @param body - shell lines run after the marker is written.
 * @returns the script path and the marker path.
 */
function hostileProgram(name: string, body = 'exit 0'): { script: string; marker: string } {
  const script = join(world.root, `${name}.sh`)
  const marker = join(world.root, `${name}.ran`)
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n${body}\n`)
  chmodSync(script, 0o755)
  return { script, marker }
}

/** A repository with one committed file, `a.txt`, attached to the `evil` filter by attributes. */
function repository(): string {
  const repo = join(world.root, 'repo')
  git(world.root, 'init', '-q', repo)
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil diff=conv\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  return repo
}

/**
 * Change `a.txt` without changing its size, and push its mtime past the index's, so git cannot tell
 * from stat data alone and must hash the file — the moment it runs a clean filter.
 */
function touchSameSize(repo: string): void {
  const file = join(repo, 'a.txt')
  writeFileSync(file, 'two\n')
  const future = new Date(Date.now() + 60_000)
  utimesSync(file, future, future)
}

/** A `ctx` whose `fs` and `subprocess` are the real filesystem and real processes. */
function realContext(): Context {
  const target = (path: string) => {
    const canonical = realpathSync(path)
    return { targetKey: canonical, displayPath: canonical }
  }
  const fs = {
    resolve: (path: string) => Promise.resolve(target(path)),
    stat: (entry: { targetKey: string }) => Promise.resolve(
      existsSync(entry.targetKey)
        ? { type: statSync(entry.targetKey).isDirectory() ? 'directory' as const : 'file' as const }
        : undefined,
    ),
    processPath: (entry: { targetKey: string }) => entry.targetKey,
    contains: (parent: { targetKey: string }, child: { targetKey: string }) => {
      const path = relative(parent.targetKey, child.targetKey)
      return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path))
    },
  }
  const subprocess = {
    resolveExecutable: () => Promise.resolve(execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()),
    spawn: (spec: { argv: readonly string[]; cwd: string; env?: Record<string, string> }) => {
      const [executable = 'git', ...args] = spec.argv
      const child = spawn(executable, args, { cwd: spec.cwd, env: { ...world.env, ...spec.env } })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
      const reader = (chunks: readonly Buffer[]) => ({
        readFrom: () => {
          const text = Buffer.concat(chunks).toString('utf8')
          return { text, nextOffset: text.length, lossy: false }
        },
      })
      return {
        pid: child.pid,
        collected: { stdout: reader(stdout), stderr: reader(stderr) },
        done: new Promise((resolve) => {
          child.on('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
        }),
      }
    },
  }
  const ctx = { get: (key: string) => (key === 'fs' ? fs : key === 'subprocess' ? subprocess : undefined) }
  // Only `get` is read by the git reader; the cast confines that to this line.
  return ctx as unknown as Context
}

describe('readings run no program the repository config names', () => {
  it('does not run a repository-configured core.fsmonitor when the Changes panel reads status', async () => {
    const repo = repository()
    const monitor = hostileProgram('fsmonitor', 'echo 0')
    git(repo, 'config', 'core.fsmonitor', monitor.script)
    touchSameSize(repo)

    const status = await new GitReader(realContext(), () => SETTINGS).status({ workspacePath: repo })

    expect(status).toMatchObject({ ok: true, branch: 'main' })
    expect(status.ok && status.unstaged.map(change => change.path)).toEqual(['a.txt'])
    expect(existsSync(monitor.marker)).toBe(false)
  })

  it('does not run a clean filter defined in the repository config while reading status or a diff', async () => {
    const repo = repository()
    const clean = hostileProgram('clean', 'cat')
    git(repo, 'config', 'filter.evil.clean', clean.script)
    touchSameSize(repo)
    const reader = new GitReader(realContext(), () => SETTINGS)

    const status = await reader.status({ workspacePath: repo })
    const diff = await reader.diff({ workspacePath: repo, path: 'a.txt', staged: false, untracked: false })

    expect(status.ok).toBe(true)
    expect(diff).toMatchObject({ ok: true, path: 'a.txt' })
    expect(existsSync(clean.marker)).toBe(false)
  })

  it('still runs a clean filter from the operator\'s own global config, where git-lfs installs one', async () => {
    const repo = repository()
    const clean = hostileProgram('global-clean', 'cat')
    writeFileSync(world.globalConfig, `[user]\n\tname = Test\n\temail = test@example.com\n[filter "evil"]\n\tclean = ${clean.script}\n`)
    touchSameSize(repo)

    const status = await new GitReader(realContext(), () => SETTINGS).status({ workspacePath: repo })

    expect(status.ok).toBe(true)
    expect(existsSync(clean.marker)).toBe(true)
  })

  it('renders a patch without diff.external or a textconv driver from the repository config', async () => {
    const repo = repository()
    const external = hostileProgram('external')
    const textconv = hostileProgram('textconv', 'cat "$1"')
    git(repo, 'config', 'diff.external', external.script)
    git(repo, 'config', 'diff.conv.textconv', textconv.script)
    writeFileSync(join(repo, 'a.txt'), 'changed\n')

    const diff = await new GitReader(realContext(), () => SETTINGS)
      .diff({ workspacePath: repo, path: 'a.txt', staged: false, untracked: false })

    expect(diff).toMatchObject({ ok: true })
    expect(diff.ok && diff.patch).toContain('+changed')
    expect(existsSync(external.marker)).toBe(false)
    expect(existsSync(textconv.marker)).toBe(false)
  })

  it('refuses to read a repository whose filter driver cannot be switched off from the command line', async () => {
    const repo = repository()
    const clean = hostileProgram('unaddressable', 'cat')
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=a=b\n')
    git(repo, 'config', 'filter.a=b.clean', clean.script)
    touchSameSize(repo)

    const status = await new GitReader(realContext(), () => SETTINGS).status({ workspacePath: repo })

    expect(status).toMatchObject({ ok: false, code: 'git-failed' })
    expect(existsSync(clean.marker)).toBe(false)
  })
})

describe('Publish names only a real branch, never an option', () => {
  /** A repository with a bare `origin` it can publish to. */
  function publishable(): { repo: string; bare: string } {
    const repo = repository()
    const bare = join(world.root, 'origin.git')
    git(world.root, 'init', '-q', '--bare', bare)
    git(repo, 'remote', 'add', 'origin', bare)
    return { repo, bare }
  }

  it('refuses a HEAD of refs/heads/--receive-pack=<script> and runs nothing', async () => {
    const { repo, bare } = publishable()
    const payload = hostileProgram('receive-pack', 'exit 1')
    const hostile = `refs/heads/--receive-pack=${payload.script}`
    git(repo, 'update-ref', hostile, 'HEAD')
    git(repo, 'symbolic-ref', 'HEAD', hostile)

    const result = await new GitReader(realContext(), () => SETTINGS)
      .push({ workspacePath: repo, setUpstream: true })

    expect(result).toMatchObject({ ok: false, code: 'git-failed' })
    expect(result.ok ? '' : result.message).toContain('not a valid branch name')
    expect(existsSync(payload.marker)).toBe(false)
    expect(git(bare, 'for-each-ref', '--format=%(refname)')).toBe('')
  })

  it('refuses a remote whose name would read as an option', async () => {
    const repo = repository()
    const bare = join(world.root, 'origin.git')
    git(world.root, 'init', '-q', '--bare', bare)
    // `git remote add` refuses such a name, so it is written the way a hostile config would carry it.
    git(repo, 'config', 'remote.--upload-pack=x.url', bare)

    const result = await new GitReader(realContext(), () => SETTINGS)
      .push({ workspacePath: repo, setUpstream: true })

    expect(result).toMatchObject({ ok: false, code: 'git-failed' })
    expect(result.ok ? '' : result.message).toContain('not a valid remote name')
  })

  it('publishes an ordinary branch and records its upstream', async () => {
    const { repo, bare } = publishable()
    git(repo, 'checkout', '-qb', 'feat/one')

    const result = await new GitReader(realContext(), () => SETTINGS)
      .push({ workspacePath: repo, setUpstream: true })

    expect(result).toMatchObject({
      ok: true, branch: 'feat/one', remote: 'origin', published: true,
      status: { ok: true, upstream: 'origin/feat/one' },
    })
    expect(git(bare, 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/feat/one')
  })
})

describe('filter override listing', () => {
  it('disarms local and unscoped drivers, keeps global and system ones, and refuses an unaddressable name', () => {
    expect(filterOverrides('local\tfilter.lfs.clean\nglobal\tfilter.lfs.process\nsystem\tfilter.x.clean\n'))
      .toEqual({ config: ['-c', 'filter.lfs.clean='] })
    // An older git prints no scope; such a line cannot prove it is the operator's, so it is disarmed.
    expect(filterOverrides('filter.a.b.process\n')).toEqual({ config: ['-c', 'filter.a.b.process='] })
    expect(filterOverrides('worktree\tfilter.a=b.clean\n')).toEqual({ unsafeKey: 'filter.a=b.clean' })
    expect(filterOverrides('')).toEqual({ config: [] })
  })
})
