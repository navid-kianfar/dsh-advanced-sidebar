import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { apply } from '../src/host/ui-preview-tool.ts'

/**
 * The `ui_preview` tool's declared surface, and its agreement with the command shape it produces.
 *
 * Two failure modes are invisible until a model hits them. The first is a parameter the tool declares
 * but never forwards, or a command property it forwards but the panel does not understand — a
 * `{ kind: 'typo' }` reaches the driver and dies there instead of at the schema. The second is a
 * rename on one side of the tool: the description names `path`, the schema calls it `filePath`, and
 * every call is a validation error the model has to guess its way out of.
 *
 * The tool is registered through a stub registry, so the real `defineTool` validates the definition
 * on the way in — the parameters, the output schema, and the presenters all pass through it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DRIVER = readFileSync(new URL('src/client/preview-driver.ts', `file://${ROOT}`), 'utf8')
const TOOL = readFileSync(new URL('src/host/ui-preview-tool.ts', `file://${ROOT}`), 'utf8')

/** One registered tool, as the stub registry saw it. */
interface Registered {
  readonly name: string
  readonly parameters: {
    readonly type: string
    readonly properties: Readonly<Record<string, { readonly type: string; readonly enum?: readonly string[] }>>
  }
  /** `presentCall` and `output.render` are the only pure surfaces reachable without executing. */
  readonly presentCall?: (args: Record<string, unknown>) => unknown
}

/** Register the tool against a stub registry and hand back what it declared. */
function registered(): Registered {
  let captured: Registered | undefined
  // The registry is read through `ctx.get`, which is what keeps the tool free of the registry
  // package's module identity; the stub answers exactly that one lookup.
  const registry = { register: (definition: Registered) => { captured = definition; return () => {} } }
  const ctx = { get: (name: string) => (name === 'tools' ? registry : undefined) }
  apply(ctx as never, { commandTimeoutMs: 15_000 })
  if (captured === undefined) throw new Error('the tool did not register')
  return captured
}

describe('the ui_preview tool surface', () => {
  it('registers nothing when the composition has no tool registry', () => {
    expect(() => { apply({ get: () => undefined } as never, { commandTimeoutMs: 1_000 }) }).not.toThrow()
  })

  it('is named ui_preview and takes an implicit object root', () => {
    const tool = registered()
    expect(tool.name).toBe('ui_preview')
    expect(tool.parameters.type).toBe('object')
  })

  it('declares exactly the actions it advertises', () => {
    expect(registered().parameters.properties.action?.enum).toEqual([
      'open', 'dom', 'eval', 'console', 'click', 'type', 'reload', 'resize', 'close',
    ])
  })

  it('declares the arguments the panel needs, and no others', () => {
    expect(Object.keys(registered().parameters.properties).sort()).toEqual([
      'action', 'cursor', 'expression', 'height', 'key', 'path', 'selector', 'text', 'url',
      'waitMs', 'width', 'workspace',
    ])
  })

  it('builds a presenter for every action without executing anything', () => {
    const tool = registered()
    const call = tool.presentCall
    expect(call).toBeDefined()
    for (const action of ['open', 'dom', 'eval', 'console', 'click', 'type', 'reload', 'resize', 'close']) {
      expect(() => call?.({ action, url: 'http://127.0.0.1:1/', path: 'a.html', selector: '#a' }), action)
        .not.toThrow()
    }
  })

  it('maps every action name the schema declares onto a command kind or an open', () => {
    // The kinds the driver handles, read from the client half rather than restated: a rename in the
    // driver must fail this test instead of failing at runtime in a browser. The driver branches on
    // `command.kind` in two forms — a `switch` case and an early `if` return — so both are matched.
    for (const kind of ['dom', 'eval', 'console', 'click', 'input', 'reload', 'resize', 'close', 'open']) {
      const handled = DRIVER.includes(`case '${kind}':`) || DRIVER.includes(`command.kind === '${kind}'`)
      expect(handled, `the driver handles ${kind}`).toBe(true)
    }
    // `type` is the tool's name for the command the driver knows as `input`, and nothing else.
    const mapping = TOOL.replace(/\s+/gu, ' ')
    expect(mapping).toContain("kind: action === 'type' ? 'input' : action")
  })

  it('contains no `any` and no untyped cast in its body', () => {
    const parsed = ts.createSourceFile('tool.ts', TOOL, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
    const offenders: string[] = []
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) offenders.push('any')
      if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword) offenders.push('as any')
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    expect(offenders).toEqual([])
  })
})
