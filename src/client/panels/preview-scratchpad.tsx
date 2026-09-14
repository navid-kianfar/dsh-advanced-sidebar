/**
 * The Preview panel's **Scratchpad** mode: an editable HTML pane whose content renders live beside it.
 *
 * The document is saved per workspace in this browser's `localStorage`, and it is rendered from the
 * Host's own scratchpad route rather than from `srcdoc`. Both are deliberate:
 *
 * - **Storage.** A scratchpad is a thought being worked out, not a deliverable; it must survive a
 *   reload without anybody having to create a file. Per workspace, because two projects' experiments
 *   have nothing to do with each other.
 * - **A real URL.** `srcdoc` gives the frame an opaque origin, so `document.baseURI`, a relative
 *   `fetch`, and `window.location` are all nonsense inside it, and the agent cannot inspect a
 *   document that has no origin. Posting the text to the Host's route gives the frame this GUI's own
 *   origin — the same property that makes Files mode inspectable.
 *
 * The editor and the render are debounced together at {@link RENDER_DEBOUNCE_MS}, because a frame
 * remounted per keystroke is unusable and a save per keystroke is what fills a storage quota.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/preview-scratchpad
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/index.ts'
import { MAX_SCRATCHPAD_CHARS, readScratchpad, writeScratchpad } from '../preview-storage.ts'
import type { PreviewModeProps } from './preview-mode.ts'
import css from './Preview.module.css'

/** How long after the last keystroke the document is rendered and saved. */
const RENDER_DEBOUNCE_MS = 500

/** The document a scratchpad starts with, so the mode opens on something that renders. */
const SEED = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head><meta charset="utf-8"><title>Scratchpad</title></head>',
  '  <body>',
  '    <h1>Scratchpad</h1>',
  '    <p>Edit the HTML on the left; this pane re-renders as you type.</p>',
  '  </body>',
  '</html>',
].join('\n')

/** What the panel needs from the scratchpad, whose `src` it also frames. */
export interface Scratchpad {
  /** The document text. */
  readonly text: string
  /** Replace the text, which schedules a save and a render. */
  readonly setText: (value: string) => void
  /** True while a save and render are pending. */
  readonly pending: boolean
  /** True when the last save was refused by the browser. */
  readonly unsaved: boolean
}

/**
 * Own the scratchpad's text, its storage, and its debounce.
 *
 * The rendered document is not this hook's business: the panel holds the frame, so the hook reports
 * the text and calls {@link onPublish} after the debounce, and the panel decides how a document
 * becomes a frame source. Keeping one owner for the frame is what makes the agent's `open` and a
 * person's keystroke land on the same state.
 * @param workspace - the workspace whose scratchpad this is.
 * @param onPublish - called with the document to render after the debounce.
 * @returns the editor's state.
 */
export function useScratchpad(
  workspace: string | undefined, onPublish: (document_: string) => void,
): Scratchpad {
  const [text, setText] = useState(() => readScratchpad(workspace) ?? SEED)
  const [pending, setPending] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const timer = useRef(0)
  const latest = useRef(text)
  const publish = useRef(onPublish)
  publish.current = onPublish

  // A different workspace is a different scratchpad: the stored document is re-read rather than
  // carried across, because the two directories' experiments have nothing to do with each other.
  useEffect(() => {
    const next = readScratchpad(workspace) ?? SEED
    setText(next)
    latest.current = next
    setUnsaved(false)
    publish.current(next)
  }, [workspace])

  const change = useCallback((value: string): void => {
    const capped = value.slice(0, MAX_SCRATCHPAD_CHARS)
    setText(capped)
    latest.current = capped
    setPending(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setPending(false)
      setUnsaved(!writeScratchpad(workspace, capped))
      publish.current(capped)
    }, RENDER_DEBOUNCE_MS)
  }, [workspace])

  useEffect(() => () => { window.clearTimeout(timer.current) }, [])

  return { text, setText: change, pending, unsaved }
}

/** What the scratchpad's controls need, beyond the shared mode contract. */
export interface ScratchpadModeProps extends PreviewModeProps {
  /** The editor's state, owned by the panel. */
  readonly scratch: Scratchpad
}

/**
 * The editor pane, its Render button, and the storage note.
 * @param props - the mode contract plus the editor state.
 * @returns the mode's controls.
 */
export function PreviewScratchpadMode({ t, scratch }: ScratchpadModeProps) {
  const note = useMemo(() => {
    if (scratch.unsaved) return t('preview.scratch.unsaved')
    if (scratch.pending) return t('preview.scratch.pending')
    return t('preview.scratch.saved')
  }, [scratch.pending, scratch.unsaved, t])

  return (
    <div className={css.scratchPane}>
      <div className={css.toolbar}>
        <span className={css.grow} />
        <Button size="sm" onClick={() => { scratch.setText(scratch.text) }}>{t('preview.scratch.render')}</Button>
      </div>
      <textarea
        className={css.scratchText}
        aria-label={t('preview.scratch.editor')}
        spellCheck={false}
        value={scratch.text}
        onChange={(event) => { scratch.setText(event.target.value) }}
      />
      <p className={css.quiet}>{note}</p>
    </div>
  )
}
