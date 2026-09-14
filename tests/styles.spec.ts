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
      'ActionMenu.module.css', 'PanelHost.module.css', 'Panels.module.css', 'Preview.module.css',
      'SettingsCard.module.css', 'Ui.module.css',
    ])
  })

  it('finds the theme package to check against', () => {
    expect(declared.size).toBeGreaterThan(50)
    expect(declared.has('--dsw-alias-label-primary')).toBe(true)
  })

  it('uses only custom properties ui-theme declares, or this package\'s own', () => {
    const missing: string[] = []
    for (const sheet of sheets) {
      for (const match of sheet.text.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const name = match[1] ?? ''
        // `--dsh-*` is this package's own namespace: the dock's reserved width is set on the app
        // frame by PanelHost, so ui-theme cannot be expected to declare it. Everything else must be
        // a token the theme owns.
        if (name.startsWith('--dsh-advanced-')) continue
        if (!declared.has(name)) missing.push(`${sheet.file}: ${name}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('reserves the frame width through this package\'s own property, not a theme token', () => {
    const dock = sheets.find(sheet => sheet.file.endsWith('PanelHost.module.css'))
    expect(dock).toBeDefined()
    // Both halves of the reservation must key on the same property, or the frame's details handle
    // would drift away from the column border it drags.
    expect(dock?.text).toContain('[data-dsh-advanced-dock] {')
    expect(dock?.text.match(/--dsh-advanced-dock-reserved/g)?.length).toBe(2)
  })

  it('never falls back to a literal behind a token', () => {
    const fallbacks: string[] = []
    for (const sheet of sheets) {
      for (const match of sheet.text.matchAll(/var\(\s*--[\w-]+\s*,[^)]*\)/g)) {
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
