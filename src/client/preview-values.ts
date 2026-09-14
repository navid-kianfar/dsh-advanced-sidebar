/**
 * How a value that crossed the frame boundary is turned into text a model can read.
 *
 * Everything the agent channel reports — a console argument, an `eval` result, an element — arrived
 * from a page nobody controls. A page can hold a cyclic object, a `BigInt`, a getter that throws, a
 * function, a DOM node, or an `Error`, and `JSON.stringify` refuses three of those outright. Each is
 * projected to something readable rather than failing the command, because "a model asked for
 * something awkward" is an ordinary event and an unexplained tool failure is not.
 *
 * Pure and frame-free, so the whole projection is stated in tests without a document.
 * @module @achasoft/dsh-advanced-sidebar/client/preview-values
 */

/** Largest text one nested value contributes before it is cut. */
const TEXT_CAP = 400

/** Largest JSON body one `eval` result may produce. */
export const EVAL_CAP = 64 * 1_024

/**
 * Render one console argument the way a browser's own console would read it.
 * @param value - the argument.
 * @returns a string.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'function') return `[Function ${value.name === '' ? 'anonymous' : value.name}]`
  if (typeof value === 'object') {
    // A DOM node would serialize to an enormous tree; its own outerHTML head is what a reader wants.
    const element = value as { outerHTML?: unknown; tagName?: unknown }
    if (typeof element.outerHTML === 'string') return element.outerHTML.slice(0, TEXT_CAP)
    try {
      return stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * Serialize a value with cycles broken and DOM nodes projected to their markup.
 * @param value - the value.
 * @returns the JSON text, or undefined when the value serializes to `undefined`.
 */
export function stringify(value: unknown): string | undefined {
  return JSON.stringify(value, createReplacer())
}

/**
 * Build a replacer that keeps one reference per object, so a cycle serializes instead of throwing.
 *
 * A fresh replacer per call, because the seen-set is per serialization: sharing one across calls
 * would label a value `[circular]` only because an earlier, unrelated call had already seen it.
 * @returns the replacer.
 */
export function createReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') return `${String(value)}n`
    if (typeof value === 'function') return `[Function ${value.name === '' ? 'anonymous' : value.name}]`
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
      // A DOM node's enumerable properties are mostly index keys and inherited accessors; its
      // markup is the useful projection, and it is what a person would see in devtools.
      const element = value as { outerHTML?: unknown }
      if (typeof element.outerHTML === 'string') return element.outerHTML.slice(0, TEXT_CAP)
    }
    return value
  }
}


/**
 * Serialize a value the way a model can read it.
 * @param value - the evaluated value.
 * @returns the JSON text, and why it is not JSON when it is not.
 */
export function safeJson(value: unknown): { text: string; note?: string } {
  try {
    return { text: stringify(value) ?? 'null' }
  } catch (error) {
    // A cyclic structure, a `BigInt`, or a getter that throws: the value is reported by its own
    // string form rather than the whole command failing, because a model asking for a DOM node's
    // identity is a legitimate call.
    return {
      text: JSON.stringify(String(value)) ?? 'null',
      note: `the value is not JSON (${error instanceof Error ? error.message : String(error)}); `
        + 'it was rendered with String()',
    }
  }
}

