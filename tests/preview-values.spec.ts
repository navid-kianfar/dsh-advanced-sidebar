import { describe, expect, it } from 'vitest'
import { describeValue, safeJson, stringify } from '../src/client/preview-values.ts'

/**
 * The projection from a framed page's value to text a model reads. Each case here is a value that
 * `JSON.stringify` alone would refuse or mangle, and each is an ordinary thing a page holds: a cycle,
 * a `BigInt`, a DOM node, an `Error`. A command that failed on any of them would be a model asking
 * something reasonable and being told "no".
 */

describe('console argument rendering', () => {
  it('passes a string through and names the primitives', () => {
    expect(describeValue('plain')).toBe('plain')
    expect(describeValue(12)).toBe('12')
    expect(describeValue(null)).toBe('null')
    expect(describeValue(undefined)).toBe('undefined')
    expect(describeValue(true)).toBe('true')
    expect(describeValue(10n)).toBe('10')
  })

  it('renders an Error, a function, and a DOM node the way a console does', () => {
    expect(describeValue(new TypeError('bad'))).toBe('TypeError: bad')
    expect(describeValue(function named() { /* noop */ })).toBe('[Function named]')
    expect(describeValue(() => { /* noop */ })).toBe('[Function anonymous]')
    // A node reports its markup rather than an object with a hundred index keys.
    expect(describeValue({ outerHTML: '<div id="a"></div>' })).toBe('<div id="a"></div>')
  })

  it('survives a value with a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'a' }
    cyclic.self = cyclic
    expect(describeValue(cyclic)).toContain('a')
  })
})

describe('eval result serialization', () => {
  it('serializes a plain value as JSON', () => {
    expect(safeJson({ a: 1, b: [true, null] })).toEqual({ text: '{"a":1,"b":[true,null]}' })
    expect(safeJson(undefined).text).toBe('null')
  })

  it('breaks a cycle instead of throwing the whole command away', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    const json = stringify(cyclic)
    expect(json).toContain('[circular]')
  })

  it('renders a BigInt and a function rather than failing on them', () => {
    expect(stringify({ big: 5n, fn: function f() { /* noop */ } }))
      .toBe('{"big":"5n","fn":"[Function f]"}')
  })

  it('projects a DOM node to its markup', () => {
    expect(stringify({ node: { outerHTML: '<p>hi</p>' } })).toBe('{"node":"<p>hi</p>"}')
  })

  it('falls back to String() with a note when even the replacer cannot serialize', () => {
    const hostile = {}
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() { throw new Error('getter exploded') },
    })
    const json = safeJson(hostile)
    // The fallback is a JSON string, not raw text: the caller places it inside a JSON body, so a
    // bare `[object Object]` would make that body unparseable and the model's reader would show a
    // syntax error instead of the value.
    expect(json.text).toBe('"[object Object]"')
    expect(json.note).toContain('not JSON')
  })

  it('starts a fresh cycle set per serialization', () => {
    // Two separate calls must not label the second value circular merely because the first call saw
    // a structurally similar one: the seen-set belongs to the serialization, not the module.
    const first = { a: 1 }
    expect(stringify({ first })).toBe('{"first":{"a":1}}')
    expect(stringify({ again: first })).toBe('{"again":{"a":1}}')
  })

  it('truncates nothing at this layer and leaves the cap to the caller', () => {
    const long = 'x'.repeat(200_000)
    expect(stringify(long)?.length).toBe(200_002)
  })
})
