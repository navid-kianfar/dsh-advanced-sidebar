import { describe, expect, it } from 'vitest'
import { parseRange, SCRATCHPAD_MAX_BYTES, FILE_ROUTE, PROXY_ROUTE, SCRATCHPAD_ROUTE } from '../src/host/preview-serve.ts'

/**
 * The byte-range parser behind `<video>` and `<audio>` seeking, plus the route paths the browser
 * builds URLs from. A wrong answer here is a media element that jumps instead of seeks, or a frame
 * that 404s — both invisible until somebody drags a scrubber.
 */

describe('range requests', () => {
  it('reads a closed range', () => {
    expect(parseRange('bytes=0-99', 1_000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=100-199', 1_000)).toEqual({ start: 100, end: 199 })
  })

  it('reads an open-ended range to the last byte', () => {
    expect(parseRange('bytes=500-', 1_000)).toEqual({ start: 500, end: 999 })
  })

  it('reads a suffix range as the last N bytes', () => {
    expect(parseRange('bytes=-200', 1_000)).toEqual({ start: 800, end: 999 })
    // A suffix longer than the file clamps to the whole file rather than going negative.
    expect(parseRange('bytes=-5000', 1_000)).toEqual({ start: 0, end: 999 })
  })

  it('clamps an end past the last byte', () => {
    expect(parseRange('bytes=900-5000', 1_000)).toEqual({ start: 900, end: 999 })
  })

  it('refuses a range that starts past the end', () => {
    expect(parseRange('bytes=1000-', 1_000)).toBe('unsatisfiable')
    expect(parseRange('bytes=2000-3000', 1_000)).toBe('unsatisfiable')
  })

  it('refuses a range on an empty file', () => {
    expect(parseRange('bytes=0-10', 0)).toBe('unsatisfiable')
  })

  it('treats a non-bytes unit, a malformed spec, and no header as a full response', () => {
    expect(parseRange(undefined, 1_000)).toBeUndefined()
    expect(parseRange('items=0-10', 1_000)).toBeUndefined()
    expect(parseRange('bytes=abc-def', 1_000)).toBeUndefined()
  })

  it('honours the first of several ranges rather than mis-parsing the list', () => {
    expect(parseRange('bytes=0-9,20-29', 1_000)).toEqual({ start: 0, end: 9 })
  })
})

describe('route paths', () => {
  it('keeps the routes absolute, un-slashed at the end, and distinct', () => {
    for (const route of [FILE_ROUTE, PROXY_ROUTE, SCRATCHPAD_ROUTE]) {
      expect(route.startsWith('/')).toBe(true)
      expect(route.endsWith('/')).toBe(false)
    }
    expect(new Set([FILE_ROUTE, PROXY_ROUTE, SCRATCHPAD_ROUTE]).size).toBe(3)
  })

  it('caps a scratchpad document well under the frame-route file cap', () => {
    expect(SCRATCHPAD_MAX_BYTES).toBe(1_024 * 1_024)
  })
})
