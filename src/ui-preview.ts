/**
 * `@achasoft/dsh-advanced-sidebar/ui-preview` — the row the agent-facing `ui_preview` tool mounts on.
 *
 * It is a separate entry, and a separate composition row, for one reason: the tool calls the
 * `advancedSidebar` service, and a row's `inject` is what makes Cordis wait for a service instead of
 * handing the plugin a context that cannot reach it. Re-exporting here rather than registering from
 * the root entry also keeps the tool out of a deployment that composes the sidebar surface without
 * wanting a model-facing verb on it: leave the row out, and the tool does not exist.
 * @module @achasoft/dsh-advanced-sidebar/ui-preview
 */

export { Config, apply, inject, name } from './host/ui-preview-tool.ts'
