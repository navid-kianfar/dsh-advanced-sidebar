/**
 * The Files panel: the session's working directory, one level at a time, with a text preview.
 *
 * The listing comes from this plugin's own endpoint rather than the Web Client's `listDirectory`,
 * because the Host's browse capability returns directories only — its one shipped caller is a
 * workspace picker, and a file browser that cannot show files is not one.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/FilesPanel
 */

import { useCallback, useEffect, useState } from 'react'
import {
  IconChevronLeftOutline14, IconFolderClose16, IconRefreshOutline14, IconRightUpOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryEntryView, ListEntriesResult, ReadFileResult } from '../../host/types.ts'
import { cx } from '../cx.ts'
import { FileGlyph } from '../Glyphs.tsx'
import { formatBytes, transportMessage, type PanelProps } from './shared.ts'
import css from './Panels.module.css'

/**
 * The directory listing and the preview beside it.
 * @param props - the target, the translator, and the drawer's face.
 * @returns the panel body.
 * @see {@link PanelProps}
 */
export function FilesPanel({ target, t, face }: PanelProps) {
  const { listEntries, readFile, openPath } = face
  const workspace = target.directory
  const [path, setPath] = useState<string | undefined>(workspace)
  const [listing, setListing] = useState<ListEntriesResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<ReadFileResult | undefined>(undefined)
  const [previewError, setPreviewError] = useState<string | undefined>(undefined)

  // A directory change resets the workspace root too, because the panel can be reopened on a
  // different session without unmounting.
  useEffect(() => { setPath(workspace); setSelected(undefined); setPreview(undefined) }, [workspace])

  useEffect(() => {
    if (path === undefined || workspace === undefined) return
    const controller = new AbortController()
    setError(undefined)
    listEntries(path, workspace, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setListing(next) },
      (reason: unknown) => { if (!controller.signal.aborted) setError(transportMessage(reason, t)) },
    )
    return () => { controller.abort() }
  }, [path, workspace, generation, listEntries, t])

  const openFile = useCallback((entry: DirectoryEntryView) => {
    if (workspace === undefined) return
    setSelected(entry.path)
    setPreview(undefined)
    setPreviewError(undefined)
    readFile(entry.path, workspace).then(
      (result) => { setPreview(result) },
      (reason: unknown) => { setPreviewError(transportMessage(reason, t)) },
    )
  }, [readFile, workspace, t])

  const level = listing?.ok === true ? listing : undefined

  return (
    <>
      <div className={css.toolbar}>
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('files.up')}
          title={t('files.up')}
          disabled={level?.parent === undefined}
          onClick={() => { if (level?.parent !== undefined) setPath(level.parent) }}
        >
          <IconChevronLeftOutline14 />
        </button>
        <span className={css.crumb} title={level?.path ?? path}>{level?.path ?? path}</span>
        <span className={css.spacer} />
        <button
          type="button"
          className={css.toolButton}
          aria-label={t('panel.refresh')}
          title={t('panel.refresh')}
          onClick={() => { setGeneration(value => value + 1) }}
        >
          <IconRefreshOutline14 />
        </button>
      </div>

      <div className={css.split}>
        <div className={css.scroll}>
          {error !== undefined && <p className={css.error}>{error}</p>}
          {listing === undefined && error === undefined && <p className={css.quiet}>{t('panel.loading')}</p>}
          {listing?.ok === false && <p className={css.error}>{listing.message}</p>}
          {level !== undefined && level.entries.length === 0 && <p className={css.quiet}>{t('files.empty')}</p>}
          {level?.entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              className={cx(css.fileRow, selected === entry.path && css.fileRowOpen)}
              onClick={() => {
                if (entry.kind === 'directory') { setPath(entry.path); setSelected(undefined); setPreview(undefined) }
                else if (entry.kind === 'file') openFile(entry)
              }}
              // A socket or a device is listed so the tree is not silently incomplete, but there is
              // nothing to open and nothing to preview.
              disabled={entry.kind === 'other'}
            >
              {entry.kind === 'directory' ? <IconFolderClose16 /> : <FileGlyph size={16} />}
              <span className={css.filePath}>{entry.name}</span>
              {entry.size !== undefined && entry.kind === 'file' && (
                <span className={css.fileSize}>{formatBytes(entry.size)}</span>
              )}
            </button>
          ))}
          {level?.truncated === true && <p className={css.quiet}>{t('changes.truncated', { n: level.entries.length })}</p>}
        </div>

        <div className={css.preview}>
          {selected === undefined && <p className={css.quiet}>{t('files.preview.pick')}</p>}
          {selected !== undefined && (
            <div className={css.previewHead}>
              <span className={css.filePath} title={selected}>{selected}</span>
              <button
                type="button"
                className={css.toolButton}
                aria-label={t('files.open')}
                title={t('files.open')}
                onClick={() => { void openPath(selected) }}
              >
                <IconRightUpOutline16 />
              </button>
            </div>
          )}
          {previewError !== undefined && <p className={css.error}>{previewError}</p>}
          {selected !== undefined && preview === undefined && previewError === undefined && (
            <p className={css.quiet}>{t('panel.loading')}</p>
          )}
          {preview?.ok === false && <p className={css.error}>{preview.message}</p>}
          {preview?.ok === true && preview.binary && (
            <p className={css.quiet}>{t('files.preview.binary', { bytes: formatBytes(preview.bytes) })}</p>
          )}
          {preview?.ok === true && !preview.binary && (
            <>
              <pre className={css.previewText}>{preview.text}</pre>
              {preview.truncated && (
                <p className={css.quiet}>{t('files.preview.truncated', { n: preview.text.length })}</p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
