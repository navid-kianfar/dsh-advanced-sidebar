import { describe, expect, it } from 'vitest'
import { resolveTarget } from '../src/client/target.ts'

/** The two snapshots `resolveTarget` reads, with only the fields it touches. */
type Sessions = Parameters<typeof resolveTarget>[0]
type Workspaces = Parameters<typeof resolveTarget>[1]

/** One session list carrying the given summaries. */
function sessions(byId: Record<string, { displayTitle: string; cwd?: string }>): Sessions {
  return { byId, ids: Object.keys(byId), current: undefined } as unknown as Sessions
}

/** One workspace list carrying the given rows. */
function workspaces(items: { path: string; sessionIds: string[] }[]): Workspaces {
  return { items } as unknown as Workspaces
}

describe('resolveTarget', () => {
  it('has no target without a session', () => {
    expect(resolveTarget(sessions({}), workspaces([]), undefined)).toBeUndefined()
  })

  it('has no target for a session the list does not carry', () => {
    expect(resolveTarget(sessions({}), workspaces([]), 's-1')).toBeUndefined()
  })

  it('prefers the session’s own working directory over its workspace root', () => {
    const target = resolveTarget(
      sessions({ 's-1': { displayTitle: 'Fix login', cwd: '/repo/packages/api' } }),
      workspaces([{ path: '/repo', sessionIds: ['s-1'] }]),
      's-1',
    )
    expect(target).toEqual({ sessionId: 's-1', title: 'Fix login', directory: '/repo/packages/api' })
  })

  it('falls back to the workspace root when the session has no cwd', () => {
    const target = resolveTarget(
      sessions({ 's-1': { displayTitle: 'Fix login' } }),
      workspaces([{ path: '/repo', sessionIds: ['s-1'] }]),
      's-1',
    )
    expect(target?.directory).toBe('/repo')
  })

  it('leaves the directory absent when neither the session nor a workspace names one', () => {
    const target = resolveTarget(
      sessions({ 's-1': { displayTitle: 'Scratch' } }),
      workspaces([{ path: '/other', sessionIds: ['s-2'] }]),
      's-1',
    )
    expect(target).toEqual({ sessionId: 's-1', title: 'Scratch', directory: undefined })
  })

  it('carries the display title the sidebar shows, not the raw id', () => {
    const target = resolveTarget(
      sessions({ 's-1': { displayTitle: 'Untitled session' } }),
      workspaces([]),
      's-1',
    )
    expect(target?.title).toBe('Untitled session')
  })
})
