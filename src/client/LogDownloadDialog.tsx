/**
 * The entry that shadows the harness's session-log download button.
 *
 * It occupies the `session-log-download` cell of the header's utilities row one priority ahead of
 * the harness, which is what removes the second "⋯" (see `log-download.ts` for why shadowing was
 * chosen). What it renders in that cell is no button at all — the verb now lives in this plugin's
 * menu — only the export dialog the shadowed entry used to render beside its button.
 *
 * The dialog is a faithful re-rendering of the harness's `SessionLogDownloadDialog` (0.1.5-rc.2): the
 * same `Modal` and `Button` from `@deepseek-ai/dsh-client-ui-primitives`, the same status-to-copy
 * mapping, bound to the same controller state. It is not this plugin's own kit `Dialog` on purpose:
 * the dialog also opens after a successful `/export` command, where it has always been the
 * harness's, and a person should not see it change shape because a plugin is installed.
 * @module @achasoft/dsh-advanced-sidebar/client/LogDownloadDialog
 */

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LogDownloadSeatProps } from './contract.ts'

/**
 * The export dialog for the session this header belongs to.
 * @param props - the session, the bridged export state, the dismiss callback, and the translator.
 * @returns the modal portal while this session's dialog is open; nothing otherwise, which leaves no
 * box in the header row.
 * @see {@link LogDownloadSeatProps}
 */
export function LogDownloadDialog(props: LogDownloadSeatProps) {
  const { sessionId, useLogDownload, dismiss, t } = props
  const active = useLogDownload(view => view.active)
  const entry = useLogDownload(view => view.bySession[String(sessionId)])

  // Inactive means the harness's own entry is rendering (nothing is being shadowed), and it draws
  // this dialog itself; drawing it here too would stack two modals over one export.
  if (!active || entry === undefined) return null

  const { status } = entry
  const close = (): void => { dismiss(String(sessionId)) }
  const error = status === 'error' ? (entry.error || t('logs.dialog.commandFailed')) : null
  const title = status === 'downloading'
    ? t('logs.dialog.preparingTitle')
    : status === 'success' ? t('logs.dialog.successTitle') : t('logs.dialog.errorTitle')
  const description = status === 'downloading'
    ? t('logs.dialog.preparingDescription')
    : status === 'success' ? t('logs.dialog.successDescription') : (error ?? t('logs.dialog.commandFailed'))

  return (
    <Modal
      open={entry.open}
      onClose={close}
      title={title}
      description={description}
      closeLabel={t('logs.dialog.close')}
      footer={<Button variant="primary" onClick={close}>{t('logs.dialog.close')}</Button>}
    />
  )
}
