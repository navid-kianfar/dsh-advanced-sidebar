/**
 * `ui_preview` — the model's hands and eyes on the Preview panel.
 *
 * This is the point of the whole same-origin preview story. A page rendered in the panel is
 * same-origin with the GUI, so a small driver in the panel can read its DOM, run an expression in
 * it, and dispatch a real click — and the model can ask for exactly that through one tool. Without
 * it, "look at your UI" means asking a person to describe a screenshot.
 *
 * One tool with an `action` discriminant is the right shape here, unlike this monorepo's own task
 * tools: every action addresses the same one surface, the arguments genuinely differ per action, and
 * the alternative — nine tools — would spend nine descriptions on one subject. The conditional
 * argument requirements that shape normally costs are paid for with an explicit `require…` check per
 * action, which returns a sentence naming the missing argument instead of a schema failure the model
 * cannot read.
 *
 * **The trust boundary.** Everything this tool accepts is untrusted model input:
 *
 * - `open` with a `path` and every `file` argument are resolved through `resolveWorkspace` /
 *   `resolveInside` before anything reads them, so a path cannot leave the session's workspace. A
 *   missing workspace is a refusal, never a guess.
 * - `open` with a `url` accepts any `http(s)` URL, which is the same latitude the panel gives a
 *   person typing into its address bar. The Host's proxy that actually fetches a loopback target
 *   refuses every non-loopback host on its own, so a model cannot use this tool to fetch an intranet
 *   service through the GUI.
 * - `eval` runs inside the preview frame's own origin, which the panel has already pointed at either
 *   a same-origin route, a loopback dev server through the Host's proxy, or a URL a person typed.
 *   It can therefore reach nothing the frame itself could not.
 *
 * Every call is bounded. The command queue refuses immediately when no panel is open, fails a
 * delivered command on its own deadline, and returns the reason — a hung tool call would be worse
 * than a failed one, because the model cannot tell the difference between "slow" and "gone".
 * @module @achasoft/dsh-advanced-sidebar/host/ui-preview-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
// Type-only: the `ctx.advancedSidebar` Context merge this tool calls through.
import type {} from './index.ts'
import { parseHttpUrl } from './preview-content.ts'
import { resolveInside, resolveWorkspace } from './paths.ts'
import type { PreviewCommand, PreviewCommandResult, PreviewFileKind } from './types.ts'

/** Cordis plugin name for the model-facing tool. */
export const name = 'advanced-sidebar-ui-preview'

/** The tool registry and the sidebar service both have to be present for this tool to mean anything. */
export const inject = ['tools', 'advancedSidebar']

/** Deployment configuration for the UI preview tool. */
export interface Config {
  /** How long one command waits for the panel to answer, in milliseconds. */
  commandTimeoutMs: number
}

/** Schemastery configuration for the tool. */
export const Config: z<Config> = z.object({
  commandTimeoutMs: z.number().step(1).min(1_000).max(600_000).default(15_000),
})

/** The action names, as one union the schema and the dispatch both read. */
const ACTIONS = [
  'open', 'dom', 'eval', 'console', 'click', 'type', 'reload', 'resize', 'close',
] as const

/** One action name. */
type Action = (typeof ACTIONS)[number]

/**
 * Largest JSON body this tool will put in a result block.
 *
 * A DOM reading is already capped inside the frame, but a page whose `eval` returns a megabyte of
 * JSON is one expression away; the model is told the value was cut rather than handed a transcript
 * it cannot afford.
 */
const RESULT_MAX_CHARS = 96 * 1_024

/** Compose one text block.
 *
 * The return type is deliberately inferred rather than annotated with the harness's `ContentBlock`:
 * the build's types come from the local harness checkout while the running install has its own
 * copy, and the two copies' branded attachment ids are not identical. An inferred structural
 * `{ type: 'text'; text: string }` satisfies both, which is exactly what this block is.
 */
function text(value: string) {
  return { type: 'text' as const, text: value }
}

/**
 * Render a JSON value for a tool result, cut at {@link RESULT_MAX_CHARS}.
 * @param value - the value to serialize.
 * @returns a fenced JSON block.
 */
function jsonBlock(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch (error) {
    text = JSON.stringify({ unserializable: error instanceof Error ? error.message : String(error) })
  }
  const body = text.length > RESULT_MAX_CHARS
    ? `${text.slice(0, RESULT_MAX_CHARS)}\n…cut at ${String(RESULT_MAX_CHARS)} characters`
    : text
  return ['```json', body, '```'].join('\n')
}

/**
 * Compose the failure sentence for an action that was missing an argument.
 * @param action - the action being run.
 * @param missing - the argument it needs.
 * @returns the model-facing sentence.
 */
function requireArg(action: Action, missing: string): string {
  return `ui_preview "${action}" needs a \`${missing}\` argument`
}

/** One action's answer, as the tool's output schema declares it. */
interface ToolAnswer {
  action: Action
  ok: boolean
  summary: string
  detail?: string
}

/**
 * One command body, as the service accepts it: everything but the id, the panel, and the deadline,
 * which the queue owns.
 */
export type PreviewCommandBody =
  Omit<PreviewCommand, 'id' | 'clientId' | 'timeoutMs'>
  & { timeoutMs?: number }

/**
 * The tool registry, as this module reaches it.
 *
 * `ctx.get('tools')` rather than `ctx.tools`, and a local shape rather than the package's own
 * `declare module` merge. The two name the same object at runtime, and the indirection is what keeps
 * this file clear of the registry's module identity: `@deepseek-ai/dsh-tools` pulls in its own copy
 * of `@deepseek-ai/cordis`, so an augmentation built from this package's copy would not merge — and
 * a tool that failed to type because of which release the build resolved would be a worse trade than
 * one small structural interface. `ToolDefinition` comes from the same import as `defineTool`, so
 * the registry's contract and the definitions it accepts cannot drift apart.
 */
interface ToolRuntime {
  /**
   * Register one tool.
   * @param definition - the tool, as `defineTool` built it.
   * @returns the disposer removing it.
   */
  register(definition: ToolDefinition): () => void
}

/**
 * Register the model-facing UI preview tool.
 * @param ctx - registrant context carrying the tool registry and the sidebar service.
 * @param config - the deployment's tool configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // The row declares `inject: ['tools', …]`, so this is present in every composition that reaches
  // here; the guard is what makes one that somehow is not simply register no tool.
  const registry = ctx.get('tools') as unknown as ToolRuntime | undefined
  if (registry === undefined) return
  registry.register(defineTool({
    name: 'ui_preview',
    description:
      'See and drive a UI in the Preview panel: open a page or a workspace file in an iframe that '
      + 'is SAME-ORIGIN with the GUI, then read its DOM, run JavaScript in it, read its console, or '
      + 'click and type into it. Use this to verify a frontend change you just made, to find out why '
      + 'an element is not where it should be, or to drive a flow end to end.\n'
      + 'Actions: open (a workspace file path or an http(s) URL), dom (rendered DOM + text + box '
      + 'metrics, optionally under a CSS selector), eval (an expression in the frame, returned as '
      + 'JSON), console (buffered log/warn/error and uncaught errors), click, type (set a value and '
      + 'dispatch input + change), reload, resize (frame viewport), close.\n'
      + 'The Preview panel must already be open in the session, and a command fails with a clear '
      + 'reason rather than waiting when it is not. A page that is not same-origin (a URL the Host '
      + 'refuses to proxy, or one that redirected off this origin) cannot be inspected: the tool says '
      + 'so instead of returning an empty DOM.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description:
          'What to do. `open` points the panel at a file or URL; `dom`/`eval`/`console` inspect it; '
          + '`click`/`type` drive it; `reload`/`resize`/`close` manage the surface.',
      },
      url: { type: 'string', description: 'open: an http(s) URL. Use this or `path`, not both.' },
      path: {
        type: 'string',
        description: 'open: a workspace file, absolute or relative to the session workspace.',
      },
      workspace: {
        type: 'string',
        description: 'The absolute session workspace directory. Defaults to the session\'s own cwd.',
      },
      waitMs: {
        type: 'integer',
        description: 'open: how long the panel may take to mount and load before giving up. Defaults to the configured command timeout.',
      },
      selector: { type: 'string', description: 'dom/click/type: a CSS selector. Omitted for `dom` means the whole document.' },
      expression: { type: 'string', description: 'eval: a JavaScript expression or statement, run in the frame.' },
      cursor: { type: 'integer', description: 'console: a cursor from a previous call; omitted starts at the oldest retained line.' },
      text: { type: 'string', description: 'type: the value to set before dispatching input and change.' },
      key: { type: 'string', description: 'type: an optional key name to dispatch after the value is set, e.g. "Enter".' },
      width: { type: 'integer', description: 'resize: frame viewport width in CSS pixels.' },
      height: { type: 'integer', description: 'resize: frame viewport height in CSS pixels.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ACTIONS },
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true, description: 'One line describing what happened.' },
          detail: { type: 'string', description: 'A JSON body: the DOM reading, the evaluated value, the console entries, or the frame state.' },
        },
      },
      render: (_args, value) => [
        text(value.summary),
        ...value.detail === undefined ? [] : [text(value.detail)],
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<ToolAnswer> {
      const service = ctx.advancedSidebar
      const action = args.action
      const sessionId = exec.agent?.session.id ?? ''
      const workspace = args.workspace ?? exec.agent?.session.header.cwd

      switch (action) {
        case 'open': {
          const waitMs = args.waitMs ?? config.commandTimeoutMs
          if (args.url !== undefined && args.url !== '') {
            const parsed = parseHttpUrl(args.url)
            if (!parsed.ok) return { action, ok: false, summary: parsed.message }
            const outcome = await service.openUrl(sessionId, parsed.url.href, waitMs)
            return outcome.ok
              ? { action, ok: true, summary: outcome.message, detail: jsonBlock(outcome.detail) }
              : { action, ok: false, summary: outcome.message }
          }
          if (args.path === undefined || args.path === '') {
            return { action, ok: false, summary: `${requireArg(action, 'path')} (or a \`url\` to open)` }
          }
          // The workspace is proved before anything looks at a path: a call that names no workspace
          // and has no session cwd has nothing for a relative path to be relative to.
          if (workspace === undefined || workspace === '') {
            return {
              action,
              ok: false,
              summary: 'ui_preview needs a workspace: this call has no session working directory, so '
                + 'pass `workspace` with the absolute session directory',
            }
          }
          const root = await resolveWorkspace(ctx, workspace, exec.signal)
          if (!root.ok) return { action, ok: false, summary: root.rejection.message }
          const absolute = args.path.startsWith('/')
            ? args.path
            : `${root.value.processPath.replace(/\/$/u, '')}/${args.path}`
          const inside = await resolveInside(ctx, root.value, absolute, exec.signal)
          if (!inside.ok) return { action, ok: false, summary: inside.rejection.message }
          const info = await service.describeFile({
            workspacePath: root.value.processPath,
            path: inside.value.processPath,
          }, exec.signal)
          if (!info.ok) return { action, ok: false, summary: info.message }
          const outcome = await service.openFile({
            sessionId,
            workspacePath: root.value.processPath,
            filePath: inside.value.processPath,
            kind: info.kind,
            waitMs,
          })
          return outcome.ok
            ? {
              action,
              ok: true,
              summary: outcome.message,
              detail: jsonBlock({
                path: inside.value.processPath,
                kind: info.kind,
                contentType: info.contentType,
                bytes: info.bytes,
                sameOrigin: true,
              }),
            }
            : { action, ok: false, summary: outcome.message }
        }
        case 'dom':
        case 'eval':
        case 'console':
        case 'click':
        case 'type':
        case 'reload':
        case 'resize':
        case 'close': {
          if (action === 'eval' && (args.expression === undefined || args.expression === '')) {
            return { action, ok: false, summary: requireArg(action, 'expression') }
          }
          if ((action === 'click' || action === 'type') && (args.selector === undefined || args.selector === '')) {
            return { action, ok: false, summary: requireArg(action, 'selector') }
          }
          if (action === 'type' && args.text === undefined) {
            return { action, ok: false, summary: requireArg(action, 'text') }
          }
          if (action === 'resize' && (args.width === undefined || args.height === undefined)) {
            return { action, ok: false, summary: 'ui_preview "resize" needs both a `width` and a `height`' }
          }
          const body: PreviewCommandBody = {
            kind: action === 'type' ? 'input' : action,
            ...args.selector === undefined ? {} : { selector: args.selector },
            ...args.expression === undefined ? {} : { expression: args.expression },
            ...args.cursor === undefined ? {} : { cursor: args.cursor },
            ...args.text === undefined ? {} : { text: args.text },
            ...args.key === undefined ? {} : { key: args.key },
            ...args.width === undefined ? {} : { width: args.width },
            ...args.height === undefined ? {} : { height: args.height },
          }
          const outcome = await service.queueCommand(sessionId, body)
          if (!outcome.ok) return { action, ok: false, summary: outcome.message }
          return describe(action, outcome.result)
        }
        default:
          // The schema's enum makes this unreachable; TypeScript's exhaustiveness does not know that,
          // and a sentence is a better fallback than a thrown exception.
          return { action, ok: false, summary: `unknown action ${String(action)}` }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'open'
        ? `Preview ${args.url ?? args.path ?? ''}`
        : `Preview ${args.action}${args.selector === undefined ? '' : ` ${args.selector}`}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}

/**
 * Phrase one command result for the model.
 * @param action - the action that produced it.
 * @param result - the panel's answer.
 * @returns the tool's own answer.
 */
function describe(action: Action, result: PreviewCommandResult): ToolAnswer {
  if (result.kind === 'dom') {
    const lines = result.nodes.map(node =>
      `${'  '.repeat(node.depth)}<${node.tag}${node.selector === '' ? '' : ` ${node.selector}`}>`
      + ` ${node.display} ${String(Math.round(node.box.width))}×${String(Math.round(node.box.height))}`
      + `${node.text === '' ? '' : ` — ${JSON.stringify(node.text.slice(0, 120))}`}`)
    return {
      action,
      ok: true,
      summary: `${String(result.nodes.length)} element(s) under ${result.selector === '' ? 'the document' : JSON.stringify(result.selector)}`
        + ` in a ${String(result.viewport.width)}×${String(result.viewport.height)} viewport${result.truncated ? ' (cut short)' : ''}.`,
      detail: [lines.join('\n'), '', jsonBlock(result)].join('\n'),
    }
  }
  if (result.kind === 'eval') {
    return {
      action,
      ok: true,
      summary: `The expression returned ${result.note === undefined ? '' : `${result.note}: `}${result.value.slice(0, 400)}`,
      detail: jsonBlock(result),
    }
  }
  if (result.kind === 'console') {
    return {
      action,
      ok: true,
      summary: result.entries.length === 0
        ? 'No console output since that cursor.'
        : `${String(result.entries.length)} console entr(ies); cursor ${String(result.cursor)}`
          + `${result.lossy ? ' (earlier lines fell out of the retained window)' : ''}.`,
      ...result.entries.length === 0
        ? {}
        : { detail: [result.entries.map(entry => `[${entry.level}] ${entry.text}`).join('\n'), '', jsonBlock(result)].join('\n') },
    }
  }
  return { action, ok: true, summary: result.detail, detail: jsonBlock(result) }
}
