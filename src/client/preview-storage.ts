/**
 * Where the Preview panel's scratchpad document lives between reloads.
 *
 * A scratchpad is a thought being worked out, not a deliverable, so it is stored in this browser
 * rather than written to the workspace as a file — and per workspace, because two projects'
 * experiments have nothing to do with each other.
 *
 * Split out of the mode component so the rules are testable without a DOM, and so every storage
 * failure is handled in one place: `localStorage` may be absent (a non-browser host), disabled
 * (private modes and hardened settings), or full, and none of those may take the panel down. Each is
 * reported as "nothing saved" or "the write was refused", which the editor renders as a note.
 * @module @achasoft/dsh-plugins/dsh-advanced-sidebar/client/preview-storage
 */

/**
 * Largest document this mode will store.
 *
 * A person typing HTML reaches a few kilobytes; a megabyte is a paste of something that belongs in a
 * file. The Host's own route refuses more than its limit, so reading is capped here too rather than
 * discovering the refusal after a round trip.
 */
export const MAX_SCRATCHPAD_CHARS = 512 * 1_024

/**
 * The storage key one workspace's scratchpad lives under.
 *
 * The workspace path is the whole identity: two sessions in one directory are editing the same
 * experiment, and a session with no directory shares one global scratchpad rather than losing it.
 * @param workspace - the absolute workspace path, or undefined.
 * @returns the key.
 */
export function scratchpadKey(workspace: string | undefined): string {
  return `dsh.advancedSidebar.scratchpad:${workspace ?? ''}`
}

/**
 * The browser's own storage, or undefined where there is none.
 *
 * Read through the global each time rather than captured: a test (and a hardened browser) may make
 * it appear or vanish between calls, and a captured reference to a storage that later throws is
 * exactly the failure this module exists to contain.
 * @returns the storage, or undefined.
 */
function storage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage
  } catch {
    // Reading the property itself can throw when storage is blocked by policy.
    return undefined
  }
}

/**
 * Read one workspace's saved document.
 * @param workspace - the absolute workspace path.
 * @returns the saved document, or undefined when there is none or storage refuses.
 */
export function readScratchpad(workspace: string | undefined): string | undefined {
  try {
    const saved = storage()?.getItem(scratchpadKey(workspace))
    return saved === null || saved === undefined || saved === ''
      ? undefined
      : saved.slice(0, MAX_SCRATCHPAD_CHARS)
  } catch {
    return undefined
  }
}

/**
 * Write one workspace's document, reporting a refused write instead of throwing.
 * @param workspace - the absolute workspace path.
 * @param text - the document.
 * @returns true when the browser accepted it.
 */
export function writeScratchpad(workspace: string | undefined, text: string): boolean {
  const store = storage()
  if (store === undefined) return false
  try {
    store.setItem(scratchpadKey(workspace), text.slice(0, MAX_SCRATCHPAD_CHARS))
    return true
  } catch {
    // Almost always a quota error, which is the operator's own doing and needs a note rather than a
    // thrown exception out of a keystroke handler.
    return false
  }
}
