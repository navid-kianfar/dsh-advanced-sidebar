import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The plugin's stylesheets rebuild the harness's own chrome against its tokens, because a browser
 * half cannot import the components it is matching. That makes a mistyped token invisible: an
 * undeclared custom property is invalid at computed-value time, so the rule silently inherits
 * instead of failing. This is the gate that catches it — the same check the harness applies to its
 * own settings section.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)

/** Every `*.module.css` this package ships, read as text. */
function stylesheets(directory: string): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...stylesheets(path))
    else if (entry.name.endsWith('.module.css')) found.push({ file: path.slice(ROOT.length), text: readFileSync(path, 'utf8') })
  }
  return found
}

/** Every custom property ui-theme declares, across its whole stylesheet set. */
function declaredTokens(): Set<string> {
  const themeRoot = dirname(require.resolve('@deepseek-ai/dsh-client-ui-theme/package.json'))
  const styles = join(themeRoot, 'src', 'styles')
  const names = new Set<string>()
  for (const entry of readdirSync(styles)) {
    if (!entry.endsWith('.css')) continue
    const text = readFileSync(join(styles, entry), 'utf8')
    for (const match of text.matchAll(/^\s*(--[\w-]+)\s*:/gm)) names.add(match[1] ?? '')
  }
  return names
}

const sheets = stylesheets(join(ROOT, 'src'))
const declared = declaredTokens()

describe('stylesheets', () => {
  it('ships at least one stylesheet per rendered surface', () => {
    expect(sheets.map(sheet => sheet.file.split('/').pop()).sort()).toEqual([
      'ActionMenu.module.css', 'PanelHost.module.css', 'Panels.module.css', 'SettingsCard.module.css',
    ])
  })

  it('finds the theme package to check against', () => {
    expect(declared.size).toBeGreaterThan(50)
    expect(declared.has('--dsw-alias-label-primary')).toBe(true)
  })

  it('uses only custom properties ui-theme declares', () => {
    const missing: string[] = []
    for (const sheet of sheets) {
      for (const match of sheet.text.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const name = match[1] ?? ''
        // The panel width is this package's own property, set inline by the drawer.
        if (name === '--dsh-advanced-panel-width') continue
        if (!declared.has(name)) missing.push(`${sheet.file}: ${name}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('never falls back to a literal behind a token', () => {
    const fallbacks: string[] = []
    for (const sheet of sheets) {
      for (const match of sheet.text.matchAll(/var\(\s*--[\w-]+\s*,([^)]*)\)/g)) {
        const fallback = (match[1] ?? '').trim()
        // The drawer's own width has a literal default on purpose: the inline property is absent
        // until the settings scope resolves, and a zero-width drawer would be worse than a default.
        if (sheet.text.includes('--dsh-advanced-panel-width') && fallback === '420px') continue
        fallbacks.push(`${sheet.file}: ${match[0]}`)
      }
    }
    expect(fallbacks).toEqual([])
  })

  it('states no literal colour', () => {
    const literals: string[] = []
    for (const sheet of sheets) {
      for (const match of sheet.text.matchAll(/(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()/g)) {
        literals.push(`${sheet.file}: ${match[0]}`)
      }
    }
    expect(literals).toEqual([])
  })
})
