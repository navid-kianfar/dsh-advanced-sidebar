import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { GitReader } from '../src/host/git.ts'
import type { AdvancedSidebarSettings } from '../src/host/types.ts'

/**
 * `git diff --no-index` compares two filesystem paths and applies no repository containment of its
 * own, so an unchecked path would read any file the Host process can and return it as a patch.
 * These assertions are the guard: an escaping path must be refused BEFORE git is spawned.
 */

/** The one settings field these readings touch, plus the required rest. */
const SETTINGS = {
  gitMaxFiles: 100, gitDiffMaxBytes: 65_536, gitTimeoutMs: 5_000,
} as unknown as AdvancedSidebarSettings

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

/** A context whose filesystem canonicalizes and contains, and whose subprocess records every spawn. */
function fakeContext(): { ctx: Context; spawns: string[][] } {
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
      const isRevParse = spec.argv.includes('rev-parse')
      const stdout = isRevParse ? '/repo\n\n' : 'diff --git a/x b/x\n'
      return {
        pid: 1,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
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
