/**
 * The Preview panel's **Files** mode: preview any file in the session workspace by type.
 *
 * The mode is a thin control surface over one Host endpoint (`previewFileInfo`), which is what
 * decides a file's kind, its size, its same-origin URL, and its change token. Deciding the kind on
 * the Host rather than in the browser is deliberate: the same table then also types the bytes the
 * file route serves, so what the panel renders and what the frame receives cannot disagree.
 *
 * The change token is what makes an edit on disk visible. It is re-read only while a file is
 * previewed, at a cadence slow enough to be free and fast enough to feel live, and a token that
 * moves REMOUNTS the frame rather than reloading it — a remount is the only way to be sure nothing
 * the previous document cached survives into the new one.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/preview-file
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IconLoadingOutline16, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PreviewFileInfo } from '../../host/types.ts'
import { Alert, Button, Input } from '../ui/index.ts'
import { absoluteIn, formatBytes, transportMessage } from './shared.tsx'
import type { PreviewModeProps } from './preview-mode.ts'
import type { PanelFace } from '../preview-types.ts'
import css from './Preview.module.css'

/** How often the previewed file's token is re-read while a file is open. */
const TOKEN_POLL_MS = 900

/** What the file mode needs beyond the shared mode contract. */
export interface FileModeProps extends PreviewModeProps {
  /** The dock's face, for the one endpoint this mode calls. */
  readonly face: PanelFace
  /** The workspace a path is resolved against, absent when the session has none. */
  readonly workspace: string | undefined
  /** The file's description, owned by the panel because it decides the frame. */
  readonly info: PreviewFileInfo | undefined
  /** True while a description is in flight. */
  readonly busy: boolean
  /** Replace the description. */
  readonly onInfo: (info: PreviewFileInfo | undefined) => void
  /** A failure phrased for the panel's error line. */
  readonly onError: (message: string | undefined) => void
}

/**
 * Read one file's description, contained to the workspace by the Host.
 *
 * The workspace is sent with the path and the Host proves containment, so a mistyped absolute path
 * is refused by the same check the Files panel uses rather than by a string comparison here.
 * @param face - the dock's face.
 * @param workspace - the workspace the path must stay inside.
 * @param path - the file, absolute or relative.
 * @param signal - cancellation for the read.
 * @returns the description, or a failure.
 */
export async function loadFileInfo(
  face: PanelFace, workspace: string, path: string, signal?: AbortSignal,
): Promise<PreviewFileInfo | { error: string }> {
  const result = await face.previewFileInfo(workspace, path, signal)
  if (!result.ok) return { error: result.message }
  return result
}

/**
 * Re-read one open file's token and report when it moved.
 * @param face - the dock's face.
 * @param workspace - the workspace.
 * @param path - the file on screen, or undefined to watch nothing.
 * @param onInfo - called with every successful reading.
 * @param onChanged - called when the file's token moved.
 */
export function useFileWatch(
  face: PanelFace,
  workspace: string | undefined,
  path: string | undefined,
  onInfo: (info: PreviewFileInfo) => void,
  onChanged: () => void,
): void {
  // The callbacks are held in a ref so a re-render does not tear the interval down and re-arm it,
  // which at this cadence would restart the watch on every keystroke elsewhere in the panel.
  const latest = useRef({ onInfo, onChanged })
  latest.current = { onInfo, onChanged }
  const token = useRef<string | undefined>(undefined)

  useEffect(() => {
    token.current = undefined
    if (workspace === undefined || path === undefined || path === '') return
    let live = true
    const timer = window.setInterval(() => {
      face.previewFileInfo(workspace, path).then(
        (result) => {
          if (!live || !result.ok) return
          const next = result
          latest.current.onInfo(next)
          if (token.current !== undefined && token.current !== next.token) {
            token.current = next.token
            latest.current.onChanged()
          } else {
            token.current = next.token
          }
        },
        () => {
          // A transient failure on a watch tick is not worth an error line: the next tick either
          // succeeds, or the file is gone and the operator finds out when they act on it.
        },
      )
    }, TOKEN_POLL_MS)
    return () => { live = false; window.clearInterval(timer) }
    // `face` is the dock's injected face, which the renderer builds once per registration and does
    // not replace between renders, so this effect arms one interval per file rather than one per
    // render. Listing `previewFileInfo` separately would defeat that: it is read off `face` and a
    // fresh function identity per render would restart the watch and lose the token it compares.
  }, [face, workspace, path])
}

/**
 * The path field, the file's facts, and the manual Refresh.
 * @param props - the mode contract plus the file's state.
 * @returns the mode's controls.
 */
export function PreviewFileMode({
  t, face, state, setState, workspace, info, busy, onInfo, onError,
}: FileModeProps) {
  const [draft, setDraft] = useState(state.filePath)
  // The field follows the panel until a person edits it: an agent's `open` has to be visible in the
  // field, and a typed path must not be overwritten by the next render.
  useEffect(() => { setDraft(state.filePath) }, [state.filePath])

  const inspect = useCallback((path: string): void => {
    if (workspace === undefined || path === '') return
    onError(undefined)
    void loadFileInfo(face, workspace, absoluteIn(workspace, path)).then(
      (loaded) => {
        if ('error' in loaded) { onInfo(undefined); onError(loaded.error); return }
        onInfo(loaded)
      },
      (reason: unknown) => { onError(transportMessage(reason, t)) },
    )
  }, [face, workspace, onInfo, onError, t])

  const open = (): void => {
    const path = draft.trim()
    setState({ filePath: path, committed: true })
    inspect(path)
  }

  const kind = info?.kind
  const framed = info?.kind === 'iframe' && info.url !== undefined
  const drawnHere = kind === 'markdown' || kind === 'image' || kind === 'media' || kind === 'pdf'

  return (
    <>
      <div className={css.toolbar}>
        <Input
          className={css.grow}
          code
          spellCheck={false}
          autoComplete="off"
          aria-label={t('preview.file.field')}
          placeholder={t('preview.file.placeholder')}
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') open() }}
        />
        <Button size="sm" disabled={draft.trim() === '' || workspace === undefined} onClick={open}>
          {t('preview.file.open')}
        </Button>
        <Button
          size="icon"
          aria-label={t('panel.refresh')}
          title={t('panel.refresh')}
          disabled={info === undefined}
          onClick={() => { if (info !== undefined) inspect(info.path) }}
        >
          {busy ? <IconLoadingOutline16 /> : <IconRefreshOutline14 />}
        </Button>
      </div>

      {workspace === undefined && <p className={css.quiet}>{t('preview.file.noWorkspace')}</p>}
      {info !== undefined && (
        <p className={css.quiet}>
          {t('preview.file.facts', {
            name: info.name,
            kind: t(`preview.kind.${kind ?? 'other'}` as 'preview.kind.other'),
            bytes: formatBytes(info.bytes),
          })}
          {info.withinLimit ? '' : ` — ${t('preview.file.overLimit')}`}
        </p>
      )}
      {info !== undefined && !framed && !drawnHere && !info.withinLimit && (
        <Alert tone="default" className={css.note}>{t('preview.file.overLimit')}</Alert>
      )}
      {info !== undefined && !framed && !drawnHere && info.withinLimit && (
        <Alert tone="default" className={css.note}>{t('preview.file.notPreviewable')}</Alert>
      )}
      {info === undefined && state.filePath === '' && <p className={css.quiet}>{t('preview.file.empty')}</p>}
    </>
  )
}
