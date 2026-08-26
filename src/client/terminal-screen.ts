/**
 * A minimal terminal screen: enough of the control vocabulary that a shell prompt, a progress line,
 * and ordinary command output all read correctly.
 *
 * This is deliberately not a terminal emulator. The panel's job is to show what a command printed,
 * not to run a full-screen editor, so colour and cursor addressing are discarded rather than
 * modelled — but the sequences that change what the text SAYS are honoured, because dropping them
 * turns a progress bar into thousands of duplicate lines and a prompt redraw into gibberish:
 *
 * - CR returns to column 0, so the next characters overwrite the line rather than starting one.
 * - BS steps back one column, which is how a shell erases a character during line editing.
 * - `CSI K` (with parameter 0, 1, or 2) erases part of the line the cursor sits on.
 *
 * Feeding is incremental: the panel writes each polled delta, so cost is proportional to new output
 * rather than to the whole retained scrollback.
 * @module @achasoft/dsh-advanced-sidebar/client/terminal-screen
 */

/** Tab stops, at the width every terminal defaults to. */
const TAB_WIDTH = 8

/** Escape, the byte that introduces every sequence this screen skips or applies. */
const ESC = '\u001B'

/** Bell, one of the two OSC terminators. */
const BEL = '\u0007'

/** A mutable text screen fed by {@link TerminalScreen.write}. */
export class TerminalScreen {
  private lines: string[] = ['']
  private column = 0
  /** Bumped on every mutation so React can re-render from a primitive rather than an array identity. */
  private generation = 0

  /**
   * @param maxLines - how many lines to retain; the head is dropped past it.
   */
  constructor(private readonly maxLines: number) {}

  /**
   * The current screen.
   * @returns the retained lines, oldest first.
   */
  snapshot(): readonly string[] {
    return this.lines
  }

  /**
   * A value that changes whenever the screen does.
   * @returns the mutation counter.
   */
  revision(): number {
    return this.generation
  }

  /** Discard everything and start from one empty line. */
  clear(): void {
    this.lines = ['']
    this.column = 0
    this.generation += 1
  }

  /**
   * Feed one chunk of terminal output.
   * @param text - the delta, exactly as the terminal produced it.
   */
  write(text: string): void {
    if (text === '') return
    let index = 0
    while (index < text.length) {
      const character = text[index] ?? ''
      if (character === ESC) {
        index = this.escape(text, index)
        continue
      }
      index += 1
      if (character === '\n') { this.newline(); continue }
      if (character === '\r') { this.column = 0; continue }
      if (character === '\b') { this.column = Math.max(0, this.column - 1); continue }
      if (character === '\t') {
        this.put(' '.repeat(TAB_WIDTH - (this.column % TAB_WIDTH)))
        continue
      }
      // Every other C0 control (BEL, SO, SI, ...) changes presentation, not text.
      if (character < ' ') continue
      this.put(character)
    }
    this.generation += 1
  }

  /**
   * Consume one escape sequence, applying the few that change the text.
   * @param text - the chunk being written.
   * @param start - index of the ESC byte.
   * @returns the index just past the sequence.
   */
  private escape(text: string, start: number): number {
    const next = text[start + 1]
    if (next === undefined) return start + 1
    if (next === '[') {
      // CSI: parameter bytes, then optional intermediates, then one final byte in 0x40-0x7E.
      let index = start + 2
      let parameters = ''
      while (index < text.length) {
        const character = text[index] ?? ''
        if (character >= '@' && character <= '~') {
          if (character === 'K') this.eraseInLine(parameters)
          return index + 1
        }
        parameters += character
        index += 1
      }
      // A sequence split across two polled deltas: dropping the tail is better than printing it,
      // and the next delta's leftover final byte is a single stray character at worst.
      return text.length
    }
    if (next === ']') {
      // OSC: runs to BEL or ST. Window titles and hyperlinks live here; neither is text.
      let index = start + 2
      while (index < text.length) {
        if (text[index] === BEL) return index + 1
        if (text[index] === ESC && text[index + 1] === '\\') return index + 2
        index += 1
      }
      return text.length
    }
    // Two-byte escapes (charset selection, reverse index, ...): skip the pair.
    return start + 2
  }

  /**
   * Apply the erase-in-line sequence.
   * @param parameters - the parameter bytes before the final `K`.
   */
  private eraseInLine(parameters: string): void {
    const line = this.lines[this.lines.length - 1] ?? ''
    const mode = parameters === '' ? '0' : parameters
    if (mode === '0') this.lines[this.lines.length - 1] = line.slice(0, this.column)
    else if (mode === '1') this.lines[this.lines.length - 1] = ' '.repeat(this.column) + line.slice(this.column)
    else if (mode === '2') this.lines[this.lines.length - 1] = ''
  }

  /** Start a new line, dropping the head once the retention bound is reached. */
  private newline(): void {
    this.lines.push('')
    this.column = 0
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines)
  }

  /**
   * Write printable text at the cursor, overwriting what it covers.
   * @param text - printable characters only.
   */
  private put(text: string): void {
    const at = this.lines.length - 1
    const line = this.lines[at] ?? ''
    const padded = line.length < this.column ? line + ' '.repeat(this.column - line.length) : line
    this.lines[at] = padded.slice(0, this.column) + text + padded.slice(this.column + text.length)
    this.column += text.length
  }
}
