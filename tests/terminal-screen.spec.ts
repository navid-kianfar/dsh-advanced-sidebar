import { describe, expect, it } from 'vitest'
import { TerminalScreen } from '../src/client/terminal-screen.ts'

/** Escape, spelled once so no test file carries a raw control byte. */
const ESC = '\u001B'

/** Bell, the shorter of the two OSC terminators. */
const BEL = '\u0007'

describe('TerminalScreen', () => {
  it('splits on newlines', () => {
    const screen = new TerminalScreen(100)
    screen.write('one\ntwo\n')
    expect(screen.snapshot()).toEqual(['one', 'two', ''])
  })

  it('overwrites the line after a carriage return', () => {
    const screen = new TerminalScreen(100)
    screen.write('100%\rdone')
    expect(screen.snapshot()).toEqual(['done'])
  })

  it('keeps the tail a shorter overwrite does not reach', () => {
    const screen = new TerminalScreen(100)
    screen.write('abcdef\rXY')
    expect(screen.snapshot()).toEqual(['XYcdef'])
  })

  it('steps back on a backspace', () => {
    const screen = new TerminalScreen(100)
    screen.write('abc\b\bZ')
    expect(screen.snapshot()).toEqual(['aZc'])
  })

  it('advances a tab to the next eight-column stop', () => {
    const screen = new TerminalScreen(100)
    screen.write('ab\tc')
    expect(screen.snapshot()).toEqual(['ab      c'])
  })

  it('erases to the end of the line', () => {
    const screen = new TerminalScreen(100)
    screen.write(`abcdef\r${ESC}[K`)
    expect(screen.snapshot()).toEqual([''])
  })

  it('erases the whole line', () => {
    const screen = new TerminalScreen(100)
    screen.write(`abcdef${ESC}[2K`)
    expect(screen.snapshot()).toEqual([''])
  })

  it('erases to the cursor, keeping the tail', () => {
    const screen = new TerminalScreen(100)
    screen.write(`abcdef\r${ESC}[3C`)
    // The cursor-forward sequence is skipped, so the cursor is still at 0 and `1K` blanks nothing.
    screen.write(`${ESC}[1K`)
    expect(screen.snapshot()).toEqual(['abcdef'])
  })

  it('discards colour without discarding the text it wrapped', () => {
    const screen = new TerminalScreen(100)
    screen.write(`${ESC}[31mred${ESC}[0m plain`)
    expect(screen.snapshot()).toEqual(['red plain'])
  })

  it('discards an OSC window title terminated by BEL', () => {
    const screen = new TerminalScreen(100)
    screen.write(`${ESC}]0;a title${BEL}prompt$ `)
    expect(screen.snapshot()).toEqual(['prompt$ '])
  })

  it('discards an OSC terminated by the string terminator', () => {
    const screen = new TerminalScreen(100)
    screen.write(`${ESC}]8;;https://example.com${ESC}\\link`)
    expect(screen.snapshot()).toEqual(['link'])
  })

  it('drops the tail of a sequence split across two writes rather than printing it', () => {
    const screen = new TerminalScreen(100)
    screen.write(`text${ESC}[3`)
    screen.write('1mmore')
    // The unfinished sequence is dropped; the next chunk's leftover final byte is the only residue.
    expect(screen.snapshot()[0]).toContain('text')
    expect(screen.snapshot()[0]).toContain('more')
  })

  it('drops the head past the retention bound', () => {
    const screen = new TerminalScreen(3)
    screen.write('a\nb\nc\nd\ne')
    expect(screen.snapshot()).toEqual(['c', 'd', 'e'])
  })

  it('moves its revision on every write and on clear', () => {
    const screen = new TerminalScreen(10)
    const start = screen.revision()
    screen.write('x')
    expect(screen.revision()).toBeGreaterThan(start)
    const written = screen.revision()
    screen.clear()
    expect(screen.revision()).toBeGreaterThan(written)
    expect(screen.snapshot()).toEqual([''])
  })

  it('ignores an empty write entirely', () => {
    const screen = new TerminalScreen(10)
    const start = screen.revision()
    screen.write('')
    expect(screen.revision()).toBe(start)
  })

  it('pads with spaces when the cursor is past the end of a shortened line', () => {
    const screen = new TerminalScreen(10)
    screen.write(`abcdef\r${ESC}[2Kxy`)
    expect(screen.snapshot()).toEqual(['xy'])
  })
})
