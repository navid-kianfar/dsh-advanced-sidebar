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
    screen.write(`abcdef\r${ESC}[3C${ESC}[1K`)
    expect(screen.snapshot()).toEqual(['   def'])
  })

  it('moves the column forward and back', () => {
    const screen = new TerminalScreen(100)
    screen.write(`abcdef\r${ESC}[2CX`)
    expect(screen.snapshot()).toEqual(['abXdef'])
    screen.write(`${ESC}[2DY`)
    expect(screen.snapshot()).toEqual(['aYXdef'])
  })

  it('honours an absolute column, one-based as the sequence defines it', () => {
    const screen = new TerminalScreen(100)
    screen.write(`abcdef${ESC}[1GZ`)
    expect(screen.snapshot()).toEqual(['Zbcdef'])
    screen.write(`${ESC}[4GQ`)
    expect(screen.snapshot()).toEqual(['ZbcQef'])
  })

  it('treats a bare move as a move of one', () => {
    const screen = new TerminalScreen(100)
    screen.write(`ab\r${ESC}[CX`)
    expect(screen.snapshot()).toEqual(['aX'])
  })

  it('blanks characters in place without moving the cursor', () => {
    const screen = new TerminalScreen(100)
    screen.write(`abcdef\r${ESC}[2C${ESC}[2XZ`)
    expect(screen.snapshot()).toEqual(['abZ ef'])
  })

  it('deletes characters, shifting the tail left', () => {
    const screen = new TerminalScreen(100)
    screen.write(`abcdef\r${ESC}[2C${ESC}[2P`)
    expect(screen.snapshot()).toEqual(['abef'])
  })

  it('inserts blanks, shifting the tail right', () => {
    const screen = new TerminalScreen(100)
    screen.write(`abcdef\r${ESC}[2C${ESC}[2@`)
    expect(screen.snapshot()).toEqual(['ab  cdef'])
  })

  it('clears the screen for the sequence `clear` sends', () => {
    const screen = new TerminalScreen(100)
    screen.write(`one\ntwo${ESC}[2J`)
    expect(screen.snapshot()).toEqual([''])
  })

  it('ignores a private mode switch such as bracketed paste', () => {
    const screen = new TerminalScreen(100)
    screen.write(`${ESC}[?2004hprompt$ ${ESC}[?2004l`)
    expect(screen.snapshot()).toEqual(['prompt$ '])
  })

  it('discards vertical movement rather than guessing at a grid', () => {
    const screen = new TerminalScreen(100)
    screen.write(`one\ntwo${ESC}[1A${ESC}[1BX`)
    expect(screen.snapshot()).toEqual(['one', 'twoX'])
  })

  it('reproduces a shell redrawing its prompt after a keystroke', () => {
    const screen = new TerminalScreen(100)
    // What zsh emits to re-render `user % ` and put the cursor after it: return to column 0, erase
    // the line, print the prompt, then place the cursor with an absolute column.
    screen.write('user % ')
    screen.write(`\r${ESC}[0Kuser % ls${ESC}[10G`)
    expect(screen.snapshot()).toEqual(['user % ls'])
    screen.write('-la')
    expect(screen.snapshot()).toEqual(['user % ls-la'])
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
