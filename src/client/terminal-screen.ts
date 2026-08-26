/**
 * A one-line-at-a-time terminal screen: enough of the control vocabulary that a shell prompt, an
 * interactive line edit, and a progress line all read correctly.
 *
 * This is deliberately not a full terminal emulator — there is no scroll region, no alternate
 * screen, and no vertical cursor addressing, so a full-screen editor run in the panel will not
 * render. What IS modelled is everything that decides what the current line SAYS, because an
 * interactive shell redraws its prompt constantly and a screen that drops those sequences turns
 * every keystroke into overwritten gibberish:
 *
 * - CR / BS move within the line.
 * - `CUF` / `CUB` / `CHA` / `HPA` move the column, which is how `zle` and `readline` reposition
 *   themselves after re-emitting a prompt.
 * - `EL` erases part of the line, `ECH` blanks characters in place, and `DCH` / `ICH` delete and
 *   insert them — the four a shell uses to edit text you already typed.
 * - `ED` with parameter 2 clears the screen, which is what `clear` sends.
 *
 * Colour, mode switches, bracketed paste, and window titles are discarded: they change presentation,
 * not text. Vertical movement is discarded too, and that is the honest boundary of this model.
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
   * Consume one escape sequence, applying the ones that change the text or the column.
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
          // A private sequence (`CSI ? … h`) is a mode switch — bracketed paste, cursor visibility,
          // the alternate screen — and never text.
          if (!parameters.startsWith('?')) this.csi(character, parameters)
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
   * Apply one CSI sequence.
   * @param final - the sequence's final byte.
   * @param parameters - the parameter bytes before it.
   */
  private csi(final: string, parameters: string): void {
    // Every sequence here takes one numeric parameter defaulting to 1, except the erase family,
    // whose parameter selects a mode and defaults to 0.
    const first = parameters.split(';')[0] ?? ''
    const count = first === '' ? 1 : Math.max(1, Number.parseInt(first, 10) || 1)
    const mode = first === '' ? 0 : Number.parseInt(first, 10) || 0
    switch (final) {
      case 'C': this.column += count; return
      case 'D': this.column = Math.max(0, this.column - count); return
      case 'G': case '`': this.column = Math.max(0, count - 1); return
      case 'K': this.eraseInLine(mode); return
      case 'X': this.eraseCharacters(count); return
      case 'P': this.deleteCharacters(count); return
      case '@': this.insertBlanks(count); return
      // `ED` with 2 or 3 is what `clear` sends; 0 and 1 erase relative to a cursor row this model
      // does not track, so they are dropped rather than guessed at.
      case 'J': if (mode >= 2) this.clear(); return
      default:
        // Vertical movement, scroll regions, mode changes, and colour all reach here and are
        // discarded: this model has one line under a cursor, not a grid.
    }
  }

  /** The line the cursor sits on, padded out to the cursor when it sits past the end. */
  private padded(): string {
    const line = this.lines[this.lines.length - 1] ?? ''
    return line.length < this.column ? line + ' '.repeat(this.column - line.length) : line
  }

  /**
   * Apply the erase-in-line sequence.
   * @param mode - 0 erases to the end, 1 to the cursor, 2 the whole line.
   */
  private eraseInLine(mode: number): void {
    const line = this.padded()
    if (mode === 0) this.lines[this.lines.length - 1] = line.slice(0, this.column)
    else if (mode === 1) this.lines[this.lines.length - 1] = ' '.repeat(this.column) + line.slice(this.column)
    else if (mode === 2) this.lines[this.lines.length - 1] = ''
  }

  /**
   * Blank characters in place, leaving the cursor where it was.
   * @param count - how many characters to blank.
   */
  private eraseCharacters(count: number): void {
    const line = this.padded()
    this.lines[this.lines.length - 1] = line.slice(0, this.column)
      + ' '.repeat(count)
      + line.slice(this.column + count)
  }

  /**
   * Delete characters at the cursor, shifting the rest of the line left.
   * @param count - how many characters to delete.
   */
  private deleteCharacters(count: number): void {
    const line = this.padded()
    this.lines[this.lines.length - 1] = line.slice(0, this.column) + line.slice(this.column + count)
  }

  /**
   * Insert blanks at the cursor, shifting the rest of the line right.
   * @param count - how many blanks to insert.
   */
  private insertBlanks(count: number): void {
    const line = this.padded()
    this.lines[this.lines.length - 1] = line.slice(0, this.column) + ' '.repeat(count) + line.slice(this.column)
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
    const line = this.padded()
    this.lines[this.lines.length - 1] = line.slice(0, this.column) + text + line.slice(this.column + text.length)
    this.column += text.length
  }
}
