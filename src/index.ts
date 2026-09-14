/**
 * `@achasoft/dsh-advanced-sidebar` root entry — three roles in one module, because the client module
 * system requires two of them together.
 *
 * **As a plugin**, this is the advanced sidebar's node half. The apply is empty: the browser half
 * ships via `exports["./client"]` and is discovered through the package's `dsh.client` declaration.
 * That discovery resolves `<loader row name>/package.json`, so the row naming this plugin must be
 * the BARE package name — a subpath row (`.../host`) resolves nothing and the sidebar seat is
 * silently never served.
 *
 * **As a library**, it re-exports the wire contract, so another package can type against the
 * `advancedSidebar` namespace without depending on the Host endpoint or the browser surface.
 *
 * The agent-facing `ui_preview` tool ships as its own entry (`exports["./ui-preview"]`) and its own
 * composition row, so a deployment that wants the sidebar but not a model-facing verb simply leaves
 * that row out — and the row's own `inject` is what makes the tool wait for the service it calls.
 * @module @achasoft/dsh-advanced-sidebar
 */

export type * from './host/types.ts'

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
