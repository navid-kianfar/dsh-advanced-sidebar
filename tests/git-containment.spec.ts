import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { GitReader, stripFence } from '../src/host/git.ts'
import type { AdvancedSidebarSettings } from '../src/host/types.ts'

/**
 * `git diff --no-index` compares two filesystem paths and applies no repository containment of its
 * own, so an unchecked path would read any file the Host process can and return it as a patch.
 * These assertions are the guard: an escaping path must be refused BEFORE git is spawned.
 */

/** The settings fields these readings and writes touch. */
const SETTINGS = {
  gitMaxFiles: 100, gitDiffMaxBytes: 65_536, gitTimeoutMs: 5_000, gitCommitTimeoutMs: 60_000,
  allowGitStaging: true, allowGitCommit: true,
} as unknown as AdvancedSidebarSettings

/** The same settings with both writes switched off. */
const READ_ONLY = { ...SETTINGS, allowGitStaging: false, allowGitCommit: false }

/** Canonical form of a path, with `..` resolved the way a realpath would. */
function canonical(path: string): string {
  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/**
 * What the fake git prints for one invocation.
 * @param argv - the arguments the reader passed.
 * @returns the stdout that invocation would produce.
 */
function answer(argv: readonly string[], identity: boolean): string {
  if (argv.includes('rev-parse')) return '/repo\n\n'
  if (argv.includes('var')) return identity ? 'A Person <a@example.com> 1700000000 +0000\n' : ''
  if (argv[1] === 'log') return 'abc1234\nthe subject\n'
  if (argv.includes('status')) return '# branch.head main\0'
  return 'diff --git a/x b/x\n'
}

/**
 * Whether one invocation exits non-zero in this fake world.
 * @param argv - the arguments the reader passed.
 * @param identity - whether git has an author configured.
 * @returns true when the invocation should fail.
 */
function argvFails(argv: readonly string[], identity: boolean): boolean {
  return argv.includes('var') && !identity
}

/** A context whose filesystem canonicalizes and contains, and whose subprocess records every spawn. */
function fakeContext(
  world: { identity?: boolean; staged?: boolean } = {},
): { ctx: Context; spawns: string[][] } {
  const identity = world.identity ?? true
  const staged = world.staged ?? true
  const spawns: string[][] = []
  const fs = {
    resolve: (path: string) => Promise.resolve({ targetKey: canonical(path), displayPath: canonical(path) }),
    stat: (target: { targetKey: string }) => Promise.resolve(
      target.targetKey.endsWith('.ts') ? { type: 'file' as const } : { type: 'directory' as const },
    ),
    processPath: (target: { targetKey: string }) => target.targetKey,
    contains: (parent: { targetKey: string }, child: { targetKey: string }) =>
      child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`),
  }
  const subprocess = {
    resolveExecutable: () => Promise.resolve('/usr/bin/git'),
    spawn: (spec: { argv: readonly string[] }) => {
      spawns.push([...spec.argv])
      const stdout = answer(spec.argv, identity)
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        // `diff --cached --quiet` exits 1 to mean "the index differs", which is how the commit
        // guard learns something is staged.
        done: Promise.resolve({
          exitCode: spec.argv.includes('--quiet')
            ? (staged ? 1 : 0)
            : (argvFails(spec.argv, identity) ? 1 : 0),
          signal: null,
        }),
        terminate: () => {},
        waitForExit: () => Promise.resolve(true),
      }
    },
  }
  const ctx = { get: (key: string) => (key === 'fs' ? fs : key === 'subprocess' ? subprocess : undefined) }
  return { ctx: ctx as unknown as Context, spawns }
}

describe('GitReader.diff containment', () => {
  const request = (path: string, untracked: boolean) =>
    ({ workspacePath: '/repo', path, staged: false, untracked })

  it('refuses a relative path that climbs out of the repository', async () => {
    const { ctx, spawns } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).diff(request('../../etc/passwd', true))
    expect(result).toMatchObject({ ok: false, code: 'path-denied' })
    // Only `rev-parse` may have run: the escaping path must never reach a `diff` invocation.
    expect(spawns.some(argv => argv.includes('diff'))).toBe(false)
  })

  it('refuses an absolute path outside the repository', async () => {
    const { ctx, spawns } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).diff(request('/etc/hosts', true))
    expect(result).toMatchObject({ ok: false, code: 'path-denied' })
    expect(spawns.some(argv => argv.includes('diff'))).toBe(false)
  })

  it('refuses an escaping path on the tracked branch too', async () => {
    const { ctx } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).diff(request('../outside.ts', false))
    expect(result).toMatchObject({ ok: false, code: 'path-denied' })
  })

  it('runs the diff for a path inside the repository', async () => {
    const { ctx, spawns } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).diff(request('src/app.ts', false))
    expect(result).toMatchObject({ ok: true, path: 'src/app.ts' })
    const diff = spawns.find(argv => argv.includes('diff'))
    expect(diff).toBeDefined()
    // The path stays repository-relative and behind `--`, so it can never read as an option.
    expect(diff?.slice(-2)).toEqual(['--', 'src/app.ts'])
  })

  it('keeps a path that merely contains dots', async () => {
    const { ctx } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).diff(request('src/a..b.ts', false))
    expect(result).toMatchObject({ ok: true })
  })
})

describe('GitReader staging', () => {
  const workspacePath = '/repo'

  it('refuses an escaping path before git is spawned', async () => {
    const { ctx, spawns } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS)
      .stage({ workspacePath, paths: ['src/a.ts', '../../etc/passwd'] })
    expect(result).toMatchObject({ ok: false, code: 'path-denied' })
    // One escaping path in the list refuses the WHOLE write: staging the acceptable half would
    // half-apply an operation the caller asked for as one.
    expect(spawns.some(argv => argv.includes('add'))).toBe(false)
  })

  it('refuses an absolute path', async () => {
    const { ctx } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS)
      .stage({ workspacePath, paths: ['/etc/hosts'] })
    expect(result).toMatchObject({ ok: false, code: 'path-denied' })
  })

  it('refuses an empty path list rather than staging everything', async () => {
    const { ctx, spawns } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).stage({ workspacePath, paths: [] })
    expect(result).toMatchObject({ ok: false, code: 'path-denied' })
    expect(spawns).toHaveLength(0)
  })

  it('passes paths after `--` so none can read as an option or a pathspec', async () => {
    const { ctx, spawns } = fakeContext()
    await new GitReader(ctx, () => SETTINGS).stage({ workspacePath, paths: ['src/a.ts', ':weird'] })
    const add = spawns.find(argv => argv.includes('add'))
    expect(add?.slice(1)).toEqual(['add', '--', 'src/a.ts', ':weird'])
  })

  it('unstages through `restore --staged`, which works on an unborn branch', async () => {
    const { ctx, spawns } = fakeContext()
    await new GitReader(ctx, () => SETTINGS).unstage({ workspacePath, paths: ['src/a.ts'] })
    const restore = spawns.find(argv => argv.includes('restore'))
    expect(restore?.slice(1)).toEqual(['restore', '--staged', '--', 'src/a.ts'])
  })

  it('re-reads the repository so the panel never shows the previous index', async () => {
    const { ctx, spawns } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).stage({ workspacePath, paths: ['src/a.ts'] })
    expect(result).toMatchObject({ ok: true, status: { ok: true, branch: 'main' } })
    expect(spawns.some(argv => argv.includes('status'))).toBe(true)
  })

  it('refuses every write while staging is switched off', async () => {
    const { ctx, spawns } = fakeContext()
    const reader = new GitReader(ctx, () => READ_ONLY)
    expect(await reader.stage({ workspacePath, paths: ['a'] })).toMatchObject({ ok: false, code: 'disabled' })
    expect(await reader.unstage({ workspacePath, paths: ['a'] })).toMatchObject({ ok: false, code: 'disabled' })
    // Switched off means the HOST refuses, not merely that the menu hides it.
    expect(spawns).toHaveLength(0)
  })
})

describe('GitReader commit', () => {
  const workspacePath = '/repo'
  const request = (message: string, amend = false) => ({ workspacePath, message, amend })

  it('refuses a blank message without touching the repository', async () => {
    const { ctx, spawns } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).commit(request('   '))
    expect(result).toMatchObject({ ok: false, code: 'empty-message' })
    expect(spawns).toHaveLength(0)
  })

  it('refuses while committing is switched off', async () => {
    const { ctx } = fakeContext()
    const result = await new GitReader(ctx, () => READ_ONLY).commit(request('a message'))
    expect(result).toMatchObject({ ok: false, code: 'disabled' })
  })

  it('passes the message as one argument to -m, so nothing in it can become an option', async () => {
    const { ctx, spawns } = fakeContext()
    await new GitReader(ctx, () => SETTINGS).commit(request('--amend --author=someone else'))
    const commit = spawns.find(argv => argv.includes('commit'))
    expect(commit?.slice(1)).toEqual(['commit', '-m', '--amend --author=someone else'])
  })

  it('adds --amend before the message when amending', async () => {
    const { ctx, spawns } = fakeContext()
    await new GitReader(ctx, () => SETTINGS).commit(request('fix typo', true))
    const commit = spawns.find(argv => argv.includes('commit'))
    expect(commit?.slice(1)).toEqual(['commit', '--amend', '-m', 'fix typo'])
  })

  it('reports the new commit and the reading that follows it', async () => {
    const { ctx } = fakeContext()
    const result = await new GitReader(ctx, () => SETTINGS).commit(request('a message'))
    expect(result).toMatchObject({
      ok: true, commit: 'abc1234', subject: 'the subject', notes: '', status: { ok: true },
    })
  })

  it('refuses when git has no author to record', async () => {
    const { ctx, spawns } = fakeContext({ identity: false })
    const result = await new GitReader(ctx, () => SETTINGS).commit(request('a message'))
    expect(result).toMatchObject({ ok: false, code: 'no-identity' })
    expect(spawns.some(argv => argv.includes('commit'))).toBe(false)
  })

  it('refuses an ordinary commit with nothing staged', async () => {
    const { ctx, spawns } = fakeContext({ staged: false })
    const result = await new GitReader(ctx, () => SETTINGS).commit(request('a message'))
    expect(result).toMatchObject({ ok: false, code: 'nothing-staged' })
    expect(spawns.some(argv => argv.includes('commit'))).toBe(false)
  })

  it('allows an amend with nothing staged, because it has the previous commit to record', async () => {
    const { ctx, spawns } = fakeContext({ staged: false })
    const result = await new GitReader(ctx, () => SETTINGS).commit(request('reword', true))
    expect(result).toMatchObject({ ok: true })
    expect(spawns.some(argv => argv.includes('commit'))).toBe(true)
  })
})

describe('commit-message fence stripping', () => {
  /**
   * The model is asked for plain text and still fences it often enough to matter: the draft goes
   * straight into the box a person commits from, so a stray ``` would reach a commit.
   */
  it('removes a fence that wraps the whole answer', () => {
    expect(stripFence('```\nfix: a thing\n```')).toBe('fix: a thing')
    expect(stripFence('```text\nfix: a thing\n\nwhy it matters\n```')).toBe('fix: a thing\n\nwhy it matters')
  })

  it('keeps a fence the message only contains', () => {
    const message = 'fix: quote the path\n\nThe old form was:\n\n```\ngit add $path\n```\n\nwhich word-splits.'
    expect(stripFence(message)).toBe(message)
  })

  it('trims without otherwise touching an unfenced message', () => {
    expect(stripFence('  fix: a thing\n')).toBe('fix: a thing')
    expect(stripFence('   ')).toBe('')
  })
})
