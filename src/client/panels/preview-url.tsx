/**
 * The Preview panel's **URL** mode controls: type an address, frame it, reload it.
 *
 * The only decision here is what "same-origin" means for an address a person typed. A loopback URL
 * is routed through the Host's own proxy so the frame becomes inspectable — which is the reason the
 * mode exists beside the dev-server one — while anything else is framed exactly as typed. A public
 * URL is not refused: looking at a page is what the person asked for. The panel says the frame will
 * be opaque, and the agent tool reports that honestly rather than returning an empty DOM.
 * @module @achasoft/dsh-advanced-sidebar/client/panels/preview-url
 */

import { useEffect, useState } from 'react'
import { frameUrlFor } from '../../host/preview-content.ts'
import { Alert, Button, Input } from '../ui/index.ts'
import type { PreviewModeProps } from './preview-mode.ts'
import css from './Preview.module.css'

/**
 * The address bar, its Go, and the cross-origin explanation.
 * @param props - the panel's mode contract.
 * @returns the mode's controls.
 */
export function PreviewUrlMode({ t, state, setState, onReload }: PreviewModeProps) {
  const [draft, setDraft] = useState(state.url)
  // The field follows the panel until a person edits it: an `open` from the agent has to be visible
  // in the address bar, and a typed address must not be overwritten by the next render.
  useEffect(() => { setDraft(state.url) }, [state.url])

  const typed = draft.trim()
  // The notice is derived from the DRAFT rather than from what is framed: a person deciding whether
  // to press Go wants to know what Go would do, not what the previous address did.
  const proxied = typed !== '' && state.proxyRoute !== undefined && frameUrlFor(state.proxyRoute, typed).sameOrigin
  const publicUrl = typed !== '' && /^https?:\/\//iu.test(typed) && !proxied

  return (
    <>
      <div className={css.toolbar}>
        <Input
          className={css.grow}
          code
          spellCheck={false}
          autoComplete="off"
          aria-label={t('preview.url.field')}
          placeholder={t('preview.url.placeholder')}
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') setState({ url: typed, committed: true })
          }}
        />
        <Button size="sm" disabled={typed === ''} onClick={() => { setState({ url: typed, committed: true }) }}>
          {t('preview.url.go')}
        </Button>
        <Button size="sm" disabled={state.url === ''} onClick={onReload}>
          {t('preview.url.reload')}
        </Button>
        <Button
          size="sm"
          disabled={typed === ''}
          onClick={() => { window.open(typed, '_blank', 'noopener,noreferrer') }}
        >
          {t('preview.newWindow')}
        </Button>
      </div>
      {proxied && <p className={css.quiet}>{t('preview.url.proxied')}</p>}
      {publicUrl && (
        <Alert tone="default" className={css.note}>
          {t('preview.url.crossOrigin')}
        </Alert>
      )}
      {typed === '' && <p className={css.quiet}>{t('preview.url.empty')}</p>}
    </>
  )
}
