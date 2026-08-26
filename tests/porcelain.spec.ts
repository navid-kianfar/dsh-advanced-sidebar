import { describe, expect, it } from 'vitest'
import { isStaged, isUnstaged, parsePorcelainV2 } from '../src/host/porcelain.ts'

/** Build a NUL-terminated payload the way `git status --porcelain=v2 -z` writes one. */
function payload(...records: string[]): string {
  return records.map(record => `${record}\0`).join('')
}

describe('parsePorcelainV2', () => {
  it('reads the branch headers', () => {
    const status = parsePorcelainV2(payload(
      '# branch.oid 0f0f0f0',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +3 -2',
    ))
    expect(status.branch).toEqual({
      branch: 'feature/x', upstream: 'origin/feature/x', ahead: 3, behind: 2, detached: false,
    })
  })

  it('reports a detached HEAD without inventing a branch name', () => {
    const status = parsePorcelainV2(payload('# branch.head (detached)'))
    expect(status.branch.detached).toBe(true)
    expect(status.branch.branch).toBeUndefined()
  })

  it('splits an ordinary record into its two index states', () => {
    const status = parsePorcelainV2(payload('1 MD N... 100644 100644 100644 aaa bbb src/app.ts'))
    expect(status.changes).toEqual([{
      path: 'src/app.ts', index: 'modified', worktree: 'deleted', untracked: false, conflicted: false,
    }])
  })

  it('keeps a path containing spaces whole', () => {
    const status = parsePorcelainV2(payload('1 .M N... 100644 100644 100644 aaa bbb docs/my notes.md'))
    expect(status.changes[0]?.path).toBe('docs/my notes.md')
  })

  it('consumes a rename record’s second path field', () => {
    const status = parsePorcelainV2(
      `2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts\0old/name.ts\0`
      + `? untracked.txt\0`,
    )
    expect(status.changes).toEqual([
      { path: 'new/name.ts', oldPath: 'old/name.ts', index: 'renamed', worktree: 'unmodified', untracked: false, conflicted: false },
      { path: 'untracked.txt', index: 'unmodified', worktree: 'untracked', untracked: true, conflicted: false },
    ])
  })

  it('marks an unmerged record conflicted in both indexes', () => {
    const status = parsePorcelainV2(payload('u UU N... 100644 100644 100644 100644 aaa bbb ccc merge.txt'))
    expect(status.changes[0]).toMatchObject({ path: 'merge.txt', conflicted: true, untracked: false })
  })

  it('skips record kinds it does not understand rather than refusing the repository', () => {
    const status = parsePorcelainV2(payload(
      '! ignored/build.log',
      'x 9 something entirely new',
      '1 A. N... 000000 100644 100644 aaa bbb added.ts',
    ))
    expect(status.changes.map(change => change.path)).toEqual(['added.ts'])
  })

  it('drops a malformed record without swallowing the one after it', () => {
    const status = parsePorcelainV2(payload('1 MM', '1 .M N... 100644 100644 100644 aaa bbb kept.ts'))
    expect(status.changes.map(change => change.path)).toEqual(['kept.ts'])
  })

  it('reads an unparsable status letter as a modification', () => {
    const status = parsePorcelainV2(payload('1 X. N... 100644 100644 100644 aaa bbb odd.ts'))
    expect(status.changes[0]?.index).toBe('modified')
  })
})

describe('group predicates', () => {
  const change = (index: string, worktree: string) => ({
    path: 'p', index, worktree, untracked: false, conflicted: false,
  } as Parameters<typeof isStaged>[0])

  it('puts a path with index changes in the staged group', () => {
    expect(isStaged(change('modified', 'unmodified'))).toBe(true)
    expect(isUnstaged(change('modified', 'unmodified'))).toBe(false)
  })

  it('lists a path that is both staged and modified in both groups', () => {
    expect(isStaged(change('added', 'modified'))).toBe(true)
    expect(isUnstaged(change('added', 'modified'))).toBe(true)
  })

  it('keeps untracked and conflicted paths out of both groups', () => {
    const untracked = { path: 'p', index: 'unmodified', worktree: 'untracked', untracked: true, conflicted: false } as Parameters<typeof isStaged>[0]
    const conflicted = { path: 'p', index: 'conflicted', worktree: 'conflicted', untracked: false, conflicted: true } as Parameters<typeof isStaged>[0]
    expect(isStaged(untracked)).toBe(false)
    expect(isUnstaged(untracked)).toBe(false)
    expect(isStaged(conflicted)).toBe(false)
    expect(isUnstaged(conflicted)).toBe(false)
  })
})
