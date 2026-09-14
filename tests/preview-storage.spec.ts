import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SCRATCHPAD_CHARS, readScratchpad, scratchpadKey, writeScratchpad,
} from '../src/client/preview-storage.ts'

/**
 * The scratchpad's storage rules. Its editing half is exercised by hand against a running panel;
 * what is asserted here is the half that must never take a panel down — a browser that refuses
 * storage at all (`localStorage` disabled, absent, or full) has to read as an ordinary "nothing
 * saved" and "the write was refused", because the alternative is an exception thrown out of a
 * keystroke handler.
 */

/** Install a fake storage on the global, the way a browser would have one. */
function install(store: Partial<Storage> | undefined): void {
  if (store === undefined) {
    Reflect.deleteProperty(globalThis, 'localStorage')
    return
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: store })
}

/** An in-memory storage that behaves like the real one for these purposes. */
function memory(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => { map.clear() },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

afterEach(() => { install(undefined); vi.restoreAllMocks() })

describe('scratchpad storage', () => {
  it('keys a document by workspace, and a directory-less session globally', () => {
    expect(scratchpadKey('/w/app')).toBe('dsh.advancedSidebar.scratchpad:/w/app')
    expect(scratchpadKey(undefined)).toBe('dsh.advancedSidebar.scratchpad:')
    expect(scratchpadKey('/w/a')).not.toBe(scratchpadKey('/w/b'))
  })

  it('round-trips a document through one workspace and keeps workspaces apart', () => {
    install(memory())
    expect(writeScratchpad('/w/a', '<p>a</p>')).toBe(true)
    expect(writeScratchpad('/w/b', '<p>b</p>')).toBe(true)
    expect(readScratchpad('/w/a')).toBe('<p>a</p>')
    expect(readScratchpad('/w/b')).toBe('<p>b</p>')
    expect(readScratchpad('/w/c')).toBeUndefined()
  })

  it('treats an empty stored value as nothing saved', () => {
    const store = memory()
    install(store)
    store.setItem(scratchpadKey('/w'), '')
    expect(readScratchpad('/w')).toBeUndefined()
  })

  it('caps what it stores and what it reads back', () => {
    const store = memory()
    install(store)
    const huge = 'x'.repeat(MAX_SCRATCHPAD_CHARS + 5_000)
    expect(writeScratchpad('/w', huge)).toBe(true)
    expect(store.getItem(scratchpadKey('/w'))?.length).toBe(MAX_SCRATCHPAD_CHARS)
    // A document written by an older, uncapped build is still read back bounded.
    store.setItem(scratchpadKey('/w'), huge)
    expect(readScratchpad('/w')?.length).toBe(MAX_SCRATCHPAD_CHARS)
  })

  it('reports a full or disabled storage as a refused write rather than throwing', () => {
    install({
      ...memory(),
      setItem: () => { throw new DOMException('QuotaExceededError') },
      getItem: () => { throw new DOMException('SecurityError') },
    })
    expect(writeScratchpad('/w', '<p>x</p>')).toBe(false)
    expect(readScratchpad('/w')).toBeUndefined()
  })

  it('reports an absent storage as nothing saved and a refused write', () => {
    install(undefined)
    expect(readScratchpad('/w')).toBeUndefined()
    expect(writeScratchpad('/w', '<p>x</p>')).toBe(false)
  })

  it('survives a global whose storage property itself throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked') },
    })
    expect(readScratchpad('/w')).toBeUndefined()
    expect(writeScratchpad('/w', 'x')).toBe(false)
  })
})
