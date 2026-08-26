/**
 * The frame-wide drawer: one `shell.overlay` entry holding whichever panel is open, the notice
 * line, and the Delete confirmation.
 *
 * `shell.overlay` is a click-through layer, so this entry renders nothing at all while no panel is
 * open and opts into pointer events only on the card itself — the app underneath stays usable
 * beside an open drawer rather than behind a modal.
 * @module @achasoft/dsh-advanced-sidebar/client/PanelHost
 */

import { useEffect } from 'react'
import type { CSSProperties } from 'react'
import { IconCloseOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelHostProps } from './contract.ts'
import { cx } from './cx.ts'
import { ChangesPanel } from './panels/ChangesPanel.tsx'
import { FilesPanel } from './panels/FilesPanel.tsx'
import { PreviewPanel } from './panels/PreviewPanel.tsx'
import { TasksPanel } from './panels/TasksPanel.tsx'
import { TerminalPanel } from './panels/TerminalPanel.tsx'
import css from './PanelHost.module.css'

/** How long a notice stays before it withdraws itself. */
const NOTICE_MS = 6_000

/** Smallest drawer the layout keeps usable; below it the panels have no room for two columns. */
const MIN_WIDTH = 280

/**
 * The drawer, the notice, and the confirmation dialog.
 * @param props - the standard kit plus this plugin's face.
 * @returns the overlay tree, or null while nothing is open.
 * @see {@link PanelHostProps}
 */
export function PanelHost(props: PanelHostProps) {
  const { t, useSidebar, useSettings, useSessions } = props
  const panel = useSidebar(state => state.panel)
  const confirm = useSidebar(state => state.confirm)
  const notice = useSidebar(state => state.notice)
  const settings = useSettings(snapshot => snapshot.value)
  const { close, dismissNotice, dismissDelete, forgetSession } = props

  // A session that leaves the list takes its drawer and its pending confirmation with it: both act
  // on an id the Host would now refuse, and leaving them open invites a click that cannot work.
  const known = useSessions((state) => {
    const id = panel.target?.sessionId ?? confirm?.target.sessionId
    return id === undefined || state.byId[id as keyof typeof state.byId] !== undefined
  })
  useEffect(() => {
    if (known) return
    const id = panel.target?.sessionId ?? confirm?.target.sessionId
    if (id !== undefined) forgetSession(id)
  }, [known, panel.target, confirm, forgetSession])

  // Escape closes the drawer, but only when the confirmation is not up: the dialog owns Escape
  // while it is open, and closing both at once would be one gesture undoing two decisions.
  useEffect(() => {
    if (panel.panel === undefined || confirm !== undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [panel.panel, confirm, close])

  const noticeId = notice?.id
  useEffect(() => {
    if (noticeId === undefined) return
    const timer = window.setTimeout(() => { dismissNotice(noticeId) }, NOTICE_MS)
    return () => { window.clearTimeout(timer) }
  }, [noticeId, dismissNotice])

  const width = Math.max(settings?.panelWidth ?? MIN_WIDTH, MIN_WIDTH)
  const target = panel.target

  return (
    <>
      {panel.panel !== undefined && target !== undefined && (
        <div
          className={css.card}
          // The token is what makes the CSS clamp honor both the setting and a narrow viewport
          // without the component measuring anything.
          style={{ '--dsh-advanced-panel-width': `${String(width)}px` } as CSSProperties}
          role="complementary"
          aria-label={t(`${panel.panel}.title` as 'changes.title')}
        >
          <header className={css.head}>
            <div className={css.headText}>
              <h2 className={css.title}>{t(`${panel.panel}.title` as 'changes.title')}</h2>
              <p className={css.subtitle} title={target.directory ?? target.title}>
                {target.directory ?? t('panel.session', { name: target.title })}
              </p>
            </div>
            <button type="button" className={css.iconButton} aria-label={t('panel.close')} onClick={close}>
              <IconCloseOutline16 />
            </button>
          </header>
          <div className={css.body}>
            {panel.panel === 'changes' && <ChangesPanel target={target} t={t} face={props} />}
            {panel.panel === 'terminal' && <TerminalPanel target={target} t={t} face={props} />}
            {panel.panel === 'files' && <FilesPanel target={target} t={t} face={props} />}
            {panel.panel === 'preview' && <PreviewPanel target={target} t={t} face={props} />}
            {panel.panel === 'tasks' && (
              <TasksPanel target={target} t={t} face={props} useSessions={useSessions} settings={settings} />
            )}
          </div>
        </div>
      )}

      {notice !== undefined && (
        <div className={cx(css.notice, notice.tone === 'error' && css.noticeError)} role="status">
          <span className={css.noticeText}>{notice.text}</span>
          <button
            type="button"
            className={css.noticeClose}
            aria-label={t('notice.dismiss')}
            onClick={() => { dismissNotice(notice.id) }}
          >
            <IconCloseOutline16 />
          </button>
        </div>
      )}

      <Modal
        open={confirm !== undefined}
        onClose={() => { if (confirm?.busy !== true) dismissDelete() }}
        title={t('delete.title')}
        closeLabel={t('delete.cancel')}
        {...confirm === undefined
          ? {}
          : { description: t(confirm.purges ? 'delete.body.purge' : 'delete.body.archive', { name: confirm.target.title }) }}
        footer={(
          <div className={css.dialogFooter}>
            <button
              type="button"
              className={css.dialogCancel}
              disabled={confirm?.busy === true}
              onClick={() => { dismissDelete() }}
            >
              {t('delete.cancel')}
            </button>
            <button
              type="button"
              className={css.dialogConfirm}
              disabled={confirm?.busy === true}
              onClick={() => { if (confirm !== undefined) void props.commitDelete(confirm.target) }}
            >
              {t('delete.confirm')}
            </button>
          </div>
        )}
      />
    </>
  )
}
