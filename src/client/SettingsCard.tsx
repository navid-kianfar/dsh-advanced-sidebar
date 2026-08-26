/**
 * The advanced-sidebar card on the plugin-configuration tab.
 *
 * It reproduces the configuration section's own chrome — an `<li>` disclosure card, and fields laid
 * out label / control / hint — because it cannot import those components: value-importing across a
 * plugin boundary fails the client bundle-purity gate, so matching is done by rebuilding against the
 * same design tokens.
 *
 * There is no save or discard. Every control writes immediately through the bound settings scope,
 * which owns revision fencing, so the card carries no staged form whose unsaved state would need
 * reporting.
 * @module @achasoft/dsh-advanced-sidebar/client/SettingsCard
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the keyed settings.plugin.item slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { AdvancedSidebarSettings } from '../host/types.ts'
import type { SettingsCardProps } from './contract.ts'
import { cx } from './cx.ts'
import { useCapabilityView } from './use-capability.ts'
import css from './SettingsCard.module.css'

/** One labelled row: a control to the right of its label, with a hint beneath. */
function Field(props: {
  id: string
  label: string
  hint: ReactNode
  /** Rendered to the right of the label, where the section's own fields put their controls. */
  control: ReactNode
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.control}
      </div>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

/**
 * The card, its four groups of fields, and the Open in roster.
 * @param props - the standard kit plus this plugin's face.
 * @returns the card element.
 * @see {@link SettingsCardProps}
 */
export function SettingsCard(props: SettingsCardProps) {
  const { t, setField, describe } = props
  const settings = props.useSidebarSettings(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const fieldId = useId()
  // The Host is asked only while the card is expanded: a collapsed card renders nothing that
  // depends on the answer, and probing every plugin card at boot would spend one PATH scan each.
  const { view } = useCapabilityView(describe, open)

  const value = settings.value
  const disabled = !settings.writable || value === undefined

  /** One boolean field, written straight through the bound scope. */
  const toggle = (
    field: keyof AdvancedSidebarSettings & string, label: string, hint: string, current: boolean,
  ): ReactNode => (
    <Field
      id={`${fieldId}-${field}`}
      label={label}
      hint={hint}
      control={(
        <input
          id={`${fieldId}-${field}`}
          className={css.switch}
          type="checkbox"
          role="switch"
          disabled={disabled}
          checked={current}
          onChange={(event) => { void setField(field, event.target.checked) }}
        />
      )}
    />
  )

  /** One integer field, refused here rather than sent when the schema would reject it. */
  const number = (
    field: string, label: string, hint: string, current: number, min: number, max: number,
  ): ReactNode => (
    <Field
      id={`${fieldId}-${field}`}
      label={label}
      hint={hint}
      control={(
        <input
          id={`${fieldId}-${field}`}
          className={css.input}
          type="number"
          min={min}
          max={max}
          inputMode="numeric"
          disabled={disabled}
          value={current}
          onChange={(event) => {
            const next = Number(event.target.value)
            // A rejected write leaves the field looking accepted, so an out-of-range entry never
            // leaves the browser.
            if (Number.isSafeInteger(next) && next >= min && next <= max) void setField(field, next)
          }}
        />
      )}
    />
  )

  const canPurge = view?.deletion.canPurge ?? true
  const ready = view === undefined
    || [view.git.available, view.terminal.available, view.files.available, view.tasks.available, view.preview.available]
      .every(Boolean)

  return (
    <li className={cx(css.card, open && css.cardOpen)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('settings.title')}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        <IconChevronDownOutline14 className={cx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div className={css.body}>
          <div className={css.groupHead}>
            <span className={css.groupTitle}>{t('settings.group.placement')}</span>
            <span className={ready ? css.badge : css.badgeMuted}>
              {ready ? t('settings.status.ready') : t('settings.status.partial')}
            </span>
          </div>
          {value !== undefined && (
            <>
              {toggle('showInSidebar', t('settings.showInSidebar'), t('settings.showInSidebar.hint'), value.showInSidebar)}
              {toggle('showInSessionHeader', t('settings.showInSessionHeader'), t('settings.showInSessionHeader.hint'), value.showInSessionHeader)}

              <div className={css.groupHead}>
                <span className={css.groupTitle}>{t('settings.group.entries')}</span>
              </div>
              {/* Each entry's hint carries what the Host said about it, so a switched-on entry that
                  cannot work says why here rather than only inside the menu. */}
              {toggle('showChanges', t('settings.showChanges'), view?.git.reason ?? t('settings.showChanges.hint'), value.showChanges)}
              {toggle('showTerminal', t('settings.showTerminal'), view?.terminal.reason ?? t('settings.showTerminal.hint'), value.showTerminal)}
              {toggle('showFiles', t('settings.showFiles'), view?.files.reason ?? t('settings.showFiles.hint'), value.showFiles)}
              {toggle('showTasks', t('settings.showTasks'), view?.tasks.reason ?? t('settings.showTasks.hint'), value.showTasks)}
              {toggle('showPreview', t('settings.showPreview'), view?.preview.reason ?? t('settings.showPreview.hint'), value.showPreview)}
              {toggle('showOpenIn', t('settings.showOpenIn'), t('settings.showOpenIn.hint'), value.showOpenIn)}
              {toggle('showArchive', t('settings.showArchive'), t('settings.showArchive.hint'), value.showArchive)}
              {toggle('showDelete', t('settings.showDelete'), t('settings.showDelete.hint'), value.showDelete)}

              <div className={css.groupHead}>
                <span className={css.groupTitle}>{t('settings.group.behavior')}</span>
              </div>
              <Field
                id={`${fieldId}-deleteMode`}
                label={t('settings.deleteMode')}
                hint={canPurge ? t('settings.deleteMode.hint') : t('settings.deleteMode.unsupported')}
                control={(
                  <select
                    id={`${fieldId}-deleteMode`}
                    className={css.select}
                    disabled={disabled || !canPurge}
                    value={value.deleteMode}
                    onChange={(event) => {
                      const mode = event.target.value
                      if (mode !== 'archive' && mode !== 'purge') return
                      // Purging is refused by the Host unless confirmation is on, and the schema
                      // rejects the pair — so the two writes go together, confirmation first.
                      if (mode === 'purge' && !value.confirmDelete) {
                        void setField('confirmDelete', true).then(() => setField('deleteMode', mode))
                        return
                      }
                      void setField('deleteMode', mode)
                    }}
                  >
                    <option value="archive">{t('settings.deleteMode.archive')}</option>
                    <option value="purge">{t('settings.deleteMode.purge')}</option>
                  </select>
                )}
              />
              <Field
                id={`${fieldId}-confirmDelete`}
                label={t('settings.confirmDelete')}
                hint={t('settings.confirmDelete.hint')}
                control={(
                  <input
                    id={`${fieldId}-confirmDelete`}
                    className={css.switch}
                    type="checkbox"
                    role="switch"
                    // Locked on while Delete removes a log: the Host refuses the combination, and a
                    // control that writes a value the Host rejects reads as broken.
                    disabled={disabled || value.deleteMode === 'purge'}
                    checked={value.confirmDelete}
                    onChange={(event) => { void setField('confirmDelete', event.target.checked) }}
                  />
                )}
              />
              {toggle('previewsFromLaunchFile', t('settings.previewsFromLaunchFile'), t('settings.previewsFromLaunchFile.hint'), value.previewsFromLaunchFile)}
              {toggle('allowTaskKill', t('settings.allowTaskKill'), t('settings.allowTaskKill.hint'), value.allowTaskKill)}
              {toggle('showTaskOutput', t('settings.showTaskOutput'), t('settings.showTaskOutput.hint'), value.showTaskOutput)}

              <div className={css.groupHead}>
                <span className={css.groupTitle}>{t('settings.group.limits')}</span>
              </div>
              {number('panelWidth', t('settings.panelWidth'), t('settings.panelWidth.hint'), value.panelWidth, 280, 1_400)}
              {number('gitMaxFiles', t('settings.gitMaxFiles'), t('settings.gitMaxFiles.hint'), value.gitMaxFiles, 1, 10_000)}
              {number('gitTimeoutMs', t('settings.gitTimeoutMs'), t('settings.gitTimeoutMs.hint'), value.gitTimeoutMs, 1_000, 600_000)}
              {number('maxTerminals', t('settings.maxTerminals'), t('settings.maxTerminals.hint'), value.maxTerminals, 1, 32)}
              {number('maxPreviews', t('settings.maxPreviews'), t('settings.maxPreviews.hint'), value.maxPreviews, 1, 16)}
              {number('previewReadyTimeoutMs', t('settings.previewReadyTimeoutMs'), t('settings.previewReadyTimeoutMs.hint'), value.previewReadyTimeoutMs, 1_000, 600_000)}
              <Field
                id={`${fieldId}-terminalShell`}
                label={t('settings.terminalShell')}
                hint={view?.terminal.detail ?? t('settings.terminalShell.hint')}
                control={(
                  <input
                    id={`${fieldId}-terminalShell`}
                    className={css.input}
                    type="text"
                    spellCheck={false}
                    placeholder="/bin/zsh"
                    disabled={disabled}
                    value={value.terminalShell}
                    onChange={(event) => { void setField('terminalShell', event.target.value) }}
                  />
                )}
              />

              <div className={css.field}>
                <div className={css.head}>
                  <span className={css.label}>{t('settings.previews')}</span>
                </div>
                <p className={css.hint}>{t('settings.previews.hint')}</p>
                {value.previews.length === 0
                  ? <p className={css.hint}>{t('settings.previews.empty')}</p>
                  : (
                    <ul className={css.targets}>
                      {value.previews.map(preview => (
                        <li key={preview.name} className={css.target}>
                          <span className={css.targetLabel}>{preview.name}</span>
                          <span className={css.badgeMuted}>
                            {preview.port > 0 ? `:${String(preview.port)}` : preview.url}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
              </div>

              <div className={css.field}>
                <div className={css.head}>
                  <span className={css.label}>{t('settings.editors')}</span>
                </div>
                <p className={css.hint}>{t('settings.editors.hint')}</p>
                {view === undefined || view.openIn.length === 0
                  ? <p className={css.hint}>{t('settings.editors.empty')}</p>
                  : (
                    <ul className={css.targets}>
                      {view.openIn.map(entry => (
                        <li key={entry.id} className={css.target}>
                          <span className={css.targetLabel}>{entry.label}</span>
                          <span className={entry.available ? css.badge : css.badgeMuted}>
                            {entry.available ? t('settings.editors.available') : t('settings.editors.missing')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            </>
          )}
        </div>
      )}
    </li>
  )
}
