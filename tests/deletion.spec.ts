import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { PURGE_UNAVAILABLE_REASON, SessionDeleter } from '../src/host/deletion.ts'
import type { AdvancedSidebarSettings, DeleteMode } from '../src/host/types.ts'

/**
 * Delete on a harness whose session persistence has no removal verb.
 *
 * The regression this guards: `purge` used to read a `supportsRawArtifacts` flag the harness never
 * had, so it was always unavailable while the settings still offered it and the result blamed the
 * backend for keeping "no per-session file". What a person sees must say the truth — the log was
 * kept, and why — on every surface: the capability, the result, and never a silent archive.
 */

/** Settings for one delete mode. */
function settings(deleteMode: DeleteMode): AdvancedSidebarSettings {
  return { showDelete: true, deleteMode } as AdvancedSidebarSettings
}

/** A context whose registry records what it archived, and whose persistence would allow anything. */
function context(): { ctx: Context; archived: string[] } {
  const archived: string[] = []
  const registry = { archiveSession: (id: string) => { archived.push(id); return Promise.resolve() } }
  // A persistence that CLAIMS every optional ability: the deleter must not take a claim as a verb.
  const persistence = { supportsRawArtifacts: true, locate: () => ({ path: '/tmp/should-never-be-removed' }) }
  const services: Record<string, unknown> = { workspaceRegistry: registry, sessionPersistence: persistence }
  return { ctx: { get: (name: string) => services[name] } as unknown as Context, archived }
}

describe('Delete on this harness', () => {
  it('reports purge as unavailable, with the reason a person can act on', () => {
    const { ctx } = context()
    expect(new SessionDeleter(ctx, () => settings('purge')).describe())
      .toEqual({ canPurge: false, reason: PURGE_UNAVAILABLE_REASON })
  })

  it('archives under purge and says in the result that the log was kept', async () => {
    const { ctx, archived } = context()
    const result = await new SessionDeleter(ctx, () => settings('purge')).delete({ sessionId: 's-1' })
    expect(result).toEqual({ ok: true, archived: true, purged: false, purgeSkippedReason: PURGE_UNAVAILABLE_REASON })
    expect(archived).toEqual(['s-1'])
  })

  it('archives under archive with no reason attached, because nothing was skipped', async () => {
    const { ctx } = context()
    const result = await new SessionDeleter(ctx, () => settings('archive')).delete({ sessionId: 's-1' })
    expect(result).toEqual({ ok: true, archived: true, purged: false })
  })
})
