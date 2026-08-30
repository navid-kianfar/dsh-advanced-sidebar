# @achasoft/dsh-advanced-sidebar

Advanced sidebar operations for the DeepSeek Harness Web Client: **Changes**, **Terminal**, **Files**, **Preview**, **Background tasks**, **Open in**, **Archive**, and **Delete**, reachable from one menu in the open session's header and shown in a **resizable dock** beside the conversation.

Everything the browser can already do goes through the Web Client's own capabilities. Everything it structurally cannot — running `git`, allocating a pseudo-terminal, launching an editor, stopping a background task, removing a session log — goes through this plugin's own Typert Remote namespace, `ctx.remote.advancedSidebar`.

Nothing here is model-facing: no tool, no prompt section, no session event.

## Install

```sh
dsh plugin --profile web add /abs/path/to/dsh-advanced-sidebar
dsh web
```

From a harness source checkout instead:

```sh
pnpm dsh plugin --profile web add ../dsh-plugins/dsh-advanced-sidebar
pnpm dsh web
```

Build the plugin first (`pnpm install && pnpm run build`); the Web Client refuses to start when a composed plugin has no built `lib/client.js`.

## The menu

The menu has one seat: the session header's utilities row. It acts on the session it sits in.

| Entry | What it opens | What it needs on the Host |
|---|---|---|
| Changes | Uncommitted changes in the session's working directory, each file's patch, and staging + commit | `git` on PATH, `ctx.subprocess`, `ctx.fs` |
| Terminal | Interactive shells of your own, on a tab strip, in that directory | `ctx.subprocess`, `ctx.fs` |
| Files | That directory, one level at a time, with a text preview | `ctx.fs` |
| Preview | The workspace's dev server, started and shown in a frame, with its logs | `ctx.subprocess`, `ctx.fs` |
| Background tasks | This session's `ctx.jobs` records, with Stop and the output of a settled one | `ctx.jobs` |
| Open in ▸ | A second browser window, a configured editor, or the operating system's file manager | `ctx.subprocess` for the editors |
| Archive | Hides the session; its log and its accounting slot remain | `ctx.workspaceRegistry` |
| Delete | Archives, and — in `purge` mode — removes the durable session log | `ctx.workspaceRegistry`, `ctx.sessionPersistence` |

An entry whose capability is missing is **disabled with the reason beside it** rather than hidden, so a mistyped `command` or an uninstalled `git` is visible instead of silent. An entry switched off in settings is absent entirely. The entry of the panel currently in the dock carries a check, so choosing it again reads as the toggle it is.

The target of every entry is the session's own `cwd`, falling back to its Workspace path. A session started in a subdirectory therefore works there, rather than at a repository root the model is not using.

## The dock

Panels open in a **resizable column on the right of the app frame**, not in a layer over it. The frame's own two columns — the sidebar and the details panel — are grid tracks a plugin cannot add to, so the dock takes the one additive frame-wide seat there is (`shell.overlay`) and reserves its width on the frame itself: `PanelHost` sets `--dsh-advanced-dock-reserved` and a marker attribute on the frame element, and two attribute-selector rules in [`PanelHost.module.css`](src/client/PanelHost.module.css) turn that into a padding on the frame plus a matching shift of the frame's own details handle, so that handle stays on the column border it drags.

Dragging the dock's left edge resizes it; so do Left and Right on the focused handle, and a double-click restores the configured width. The width is written to the controller immediately and to `panelWidth` in the settings section when the scope is writable — a remote Web Client has no settings document, and a drag there still has to resize the dock. During a drag the width is written straight to the DOM rather than through React, so a diff list or a terminal emulator is not re-rendered at pointer cadence.

How wide the dock may get is what the frame can spare: its own width **less the sidebar's**, less a 400px floor for the conversation. The sidebar is subtracted because the frame's solver never makes it concede — it holds the sidebar at its preference and lets the centre absorb every squeeze, so a ceiling measured from the frame alone spends that width twice and leaves the conversation a sliver. Below the width at which even the smallest dock would breach that floor, the dock stops reserving and floats over the conversation with a margin and an elevation. Both are measured from the frame's own box, not from a media query: the Web Client can be embedded, and the window is not the frame.

## The component kit

Every control this plugin draws comes from [`src/client/ui/`](src/client/ui), a small kit in **shadcn/ui's vocabulary**: the variant and size axes, the geometry scale, the flat bordered surfaces, and the focus ring — over the harness's own design tokens, so the components sit in the app's light and dark themes unmodified. shadcn itself cannot be installed here: it is Tailwind utilities over Radix, and this browser half ships as one bundled CSS-Modules file with no Tailwind pipeline and no second React runtime to give Radix.

`Button`, `Badge`, `Input`, `Textarea`, `Switch`, `Checkbox`, `Select`, `Tabs`, `Alert`, `Dialog`, `AlertDialog`, `DropdownMenu`, `Tooltip`, `Separator`, `Calendar`, and `DatePicker` are the pieces; [`Layer`](src/client/ui/Layer.tsx) is the portal they all float in.

The kit is also what fixes the menu. The harness's `Menu` primitive clamps a root list into the viewport but pins a submenu at `left: calc(100% + 10px)` with no collision handling — so the header's menu, which is always anchored near the right edge, pushed its `Open in` submenu off the window entirely. Every surface here is placed through [`placeLayer`](src/client/ui/anchor.ts), a pure function of four rectangles that flips a submenu to the left of its row when the right cannot hold it, shifts it to stay inside the window, and reports the height it may occupy. `tests/anchor.spec.ts` covers the flip, the shift, and the case where neither side fits.

## What each panel does, and what it deliberately does not

**Changes** reads the repository and writes to its index. The reading is `git status --porcelain=v2 --branch -z --untracked-files=all`, parsed in [`src/host/porcelain.ts`](src/host/porcelain.ts); `-z` is what keeps a path containing a space, a quote, or a newline identical between the status reading and the diff request that follows it.

Stage and unstage act on one file or a whole group, and **Commit** records what is staged, with an optional amend. Each write returns the reading that follows it, so the lists never lag a round trip behind the index they describe, and open patches are dropped with the index they described.

**Discarding is deliberately absent.** Stage, unstage, and commit are all recoverable — the working tree is untouched by the first two, and a commit stays in the reflog — while `git restore` destroys uncommitted work with nothing left to recover it from. A sidebar is the wrong place for the one irreversible verb in the set, and it is a keystroke away in the Terminal panel beside it.

Four things the panel does rather than leaving to git's own error text:

- Every path is proved to sit inside the repository before git sees it, and passed after `--` as a literal path — `git add` takes *pathspecs*, so an unchecked `:(exclude)` would stage something nobody picked.
- The message crosses as one argument to `-m`, so no shell sees it and nothing in it can become an option. A message of `--amend --author=someone` commits that text.
- The author is read with `git var GIT_AUTHOR_IDENT` — git's own answer to "who would this commit be by" — and shown under the box, so a missing `user.email` is visible *before* the button is pressed.
- Committing has its own timeout (`gitCommitTimeoutMs`, default 2 minutes) because it runs the repository's `pre-commit` hook, which can far outlast any reading; killing one mid-run leaves a stale `index.lock`. Hooks run, and a hook's stderr comes back verbatim rather than summarized.

Both writes are gated by settings (`allowGitStaging`, `allowGitCommit`) that the **Host** enforces, not just the menu: switching them off takes the verb away rather than hiding it.

**Terminal** allocates its own shells through `ctx.subprocess.spawnTerminal` — deliberately **not** `ctx.terminals`. That registry's sessions are owner-fenced to an `Agent` and are the model's working terminals; joining them would let a human's keystrokes land in a session the model believes it controls.

There are **as many shells as `maxTerminals` allows**, on a tab strip, each with its own emulator, its own poll chain, and its own Restart. The handles live in the plugin's shared controller rather than in the panel, so switching to another panel or closing the dock leaves the shells running exactly as hiding a terminal pane in an editor does; a reopened tab replays from the Host's retained scrollback rather than restarting. Closing a tab closes its shell, and so does the session going away. Every open tab stays mounted and laid out — hidden with `visibility`, never `display: none`, because a box with no layout makes the emulator's fit throw and the screen would have to be rebuilt on every tab switch.

The screen is a real terminal emulator (`@xterm/xterm`), and that is why the browser bundle is large. It is not a preference: an interactive shell redraws its prompt with cursor addressing on every keystroke, and a hand-rolled screen model renders a login shell's prompt as overwritten fragments — verified, then replaced. Colour, line editing, history recall, and full-screen programs come with the emulator. Ctrl+C is intercepted and delivered as a **signal to the foreground process group** rather than as a byte, which is the difference between interrupting a running command and doing nothing.

Output is polled, not pushed: an out-of-tree plugin has no host-to-client push channel, so the panel holds the whole-stream offset it has already written into the emulator and asks for whatever came after it. That offset is also what makes a reopened panel replay the retained scrollback.

There is no resize: the subprocess seam exposes none. The emulator follows the dock so rendered rows stay readable, but the *shell* keeps the size it was allocated at; **Restart** allocates one at the new size.

[`src/client/terminal-screen.ts`](src/client/terminal-screen.ts) survives as the log renderer for the Preview and Background tasks panels, which show plain output rather than an interactive screen.

**Files** lists through this plugin's own endpoint rather than the Web Client's `listDirectory`, because the Host's browse capability returns directories only — its one shipped caller is a workspace picker. Every path is resolved through `ctx.fs` and proved to sit inside the workspace before anything reads it.

**Preview** runs what you are building and shows it beside the conversation.

Launch configurations are read from the workspace's own **`.claude/launch.json`** — Claude Code's file, unchanged — and from the `previews` settings rows, in that order; a name declared in both is taken from the repository's file, because a repository is the authority on how to run itself. A row with a `runtimeExecutable` starts a process; a row with only a `url` is attach-only and simply points the frame at something already running.

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 },
    { "name": "docs", "runtimeExecutable": "pnpm", "runtimeArgs": ["docs:dev"], "port": 5173, "cwd": "website" }
  ]
}
```

Readiness is a **TCP connect to the configured port**, retried until it accepts or `previewReadyTimeoutMs` passes. An HTTP probe would need a path, a method, and an opinion about which status codes count; a listening socket is the one fact every dev server agrees on. `PORT` is exported to the child, and `NO_COLOR`/`FORCE_COLOR` are set so the log view shows text rather than escape sequences.

The frame is a plain `<iframe>` with viewport presets (desktop, tablet, mobile) scaled to the dock, and an editable address bar so you can navigate into a route rather than only the root. Two controls are permanent rather than error states:

- **Logs** — stdout and stderr interleaved in arrival order, read by the same caller-owned offset the Terminal panel uses. A server that failed to start has nothing to put in the frame and its stderr is the only place the reason exists, so a failed start opens the log view itself.
- **Open in a new window** — a page can refuse to be framed (`X-Frame-Options`, `frame-ancestors`), and cross-origin framing gives the panel no way to detect that: the load event fires either way. The escape hatch is therefore always present instead of appearing after a failure nothing can observe.

Stopping is `SIGTERM` then `SIGKILL` on the whole process tree after `previewGraceMs`, so a dev server's own child processes go with it. Starting a configuration that is already running replaces it rather than racing it for the port, and every server is stopped when the plugin unloads.

**Background tasks** does not fetch its list. The Host already pushes `session/jobs` frames that the Web Client folds into `jobsBySession`, so the panel reads the same live data the session header's job chip reads. Only Stop and output cross this plugin's endpoint:

The list is filtered in the browser by a text filter, a status `Select`, and a `DatePicker` bounding how old a task may be. The date is compared against a **local midnight** rather than a formatted day, so a task started at 23:30 belongs to the day the operator saw on the clock.

- **Stop** marks the registry record *reported*, which suppresses the completion notice its producer would otherwise deliver to the model. That is the correct trade for a person pressing Stop — the work is cancelled on their authority — and it is why the verb is a setting (`allowTaskKill`) rather than always on.
- **Output** is served only once a task has settled **and** its completion has been reported. `ctx.jobs.read()` consumes the same cursor the model reads from, so draining a live task's stream would silently delete output the model was about to receive. Text already drained is retained Host-side, so reopening the panel shows it again instead of an empty second read.

**Open in** distinguishes a directory from a file: a directory is opened, a file is *selected* in its folder (`open -R`, `explorer /select,`). The harness's own `host.openPath` hands a path to its default application, which is the right verb for the first and the wrong one for the second.

**Delete** is assembled, because no harness capability deletes a session — persistence is append-only and exposes no delete verb, and the workspace registry can only archive. So Delete is honest about which half it managed:

- `archive` hides the session and keeps its log.
- `purge` also removes the persistence backend's per-session artifact. Nothing undoes that, it requires `confirmDelete`, and it **never touches a live session** — a running turn would keep appending to a file that no longer exists, so the archive commits and the reason comes back with it. A backend that keeps no per-session artifact (SQLite) reports `archive` from `describe()`, so the confirmation never promises a removal that will not happen.

A live session is detected through the **agent registry**, not the session store: an agent is what runs a turn, and a cold session the store merely retains is not being written to.

## Settings

The `advanced-sidebar` section is registered by the Host half and rendered as a card on the settings **Plugins** tab. Every control writes straight through the bound settings scope, which owns revision fencing; there is no save or discard.

`describe()` also carries the **resolved section**, and every surface reads `bound scope value ?? describe().settings`. That is not redundancy: `ctx.settingsScope` resolves to a real document only on a loopback connection and answers `unavailable` with no value on every remote Web Client. Without the Host's copy the whole surface would read "no settings" as "switched off" and disappear for remote access; with it, a remote client sees the deployment's real configuration, read-only.

Every deployment-varying choice is a `config` field on the `advanced-sidebar` row in [`cordis.patch.yml`](cordis.patch.yml) — placement, which entries exist, dock width, delete mode, task permissions, git bounds, the shell, the terminal count, the file-preview bounds, and the Open in targets. The card edits all of them except the target list, which stays in `cordis.yml` where a command and its arguments can be written properly; the card shows each target's **availability on this Host**, which the file cannot state.

## Composition

Two rows, both always composed:

```yaml
- insert:
    - id: advanced-sidebar
      name: '@achasoft/dsh-advanced-sidebar/host'
      config: { ... }
    - id: advanced-sidebar-ui
      name: '@achasoft/dsh-advanced-sidebar'
```

The second row is the **bare package name** deliberately: the Web Client discovers a browser half by resolving `<row name>/package.json`, so a subpath row would leave every seat silently unserved.

Three slot registrations: `conversation.session.header.utilities`, `shell.overlay` (the dock and the Delete confirmation), and `settings.plugin.item`. They have no common React ancestor, so what a person opened — the panel, the dock's width, and the terminal tabs — lives in a controller this package owns and hands to each registration through its inject face.

There was a fourth, at the sidebar foot. It was withdrawn: the same menu in two places gave the session column an action whose target was whichever session happened to be current, which is not what a column of sessions reads as.

## The generated Typert artifact

`generated/` carries the RPC contract the browser half mounts. The harness's Typert generator reads a TypeScript program seeded from the harness's own `tsconfig.host.json`, so it cannot run against a package outside that checkout; the artifact is therefore **authored to that generator's format** by [`scripts/emit-typert.mjs`](scripts/emit-typert.mjs), which holds the endpoint list and every wire schema.

Editing `src/host/types.ts` or the `@Remote` surface means editing that spec too:

```sh
pnpm run regen:typert   # re-emits generated/ and records its fingerprint
```

`pnpm test` refuses a mismatch: `scripts/check-typert.mjs` compares declared and generated endpoints as sets and re-hashes the inputs, and `tests/typert-contract.spec.ts` parses a representative value through every descriptor's schemas.

## Development

```sh
pnpm install
pnpm run build       # tsc emit -> tsdown two-half bundle
pnpm run typecheck
pnpm test            # typert drift check + vitest
```

For a live loop, run `npx tsdown --watch` in this package: the harness's HMR half stat-polls the served bundle, so any writer of `lib/client.js` triggers a reload.

## Known limitations

- **The preview frame cannot report its own console or network.** Those need same-origin access to the framed page, which a dev server on another port does not give. The server's own logs are what the panel shows; the browser's devtools are one "Open in a new window" away.
- **No push channel.** An out-of-tree plugin cannot add a wire frame, so terminal output, preview logs, and the git reading are polled. Background tasks are the exception — they ride the Host's existing `session/jobs` push.
- **No terminal resize.** The subprocess seam has no resize verb. Long lines wrap rather than scroll, and **Restart** re-measures the box.
- **The dock reserves its width through the frame's DOM.** `shell.overlay` is the only additive frame-wide seat, and it draws above the columns rather than between them, so reserving space means setting a property and a marker on the frame element and letting two attribute-selector rules do the rest. Both are removed when the dock closes or the plugin unloads. A future frame that stops publishing `data-shell-overlay`, or that positions its details handle differently, would need this updated with it.
- **Stopping a task suppresses its model notice.** See Background tasks above; `allowTaskKill: false` removes the verb.
- **Purge removes one artifact.** Exactly the path the persistence backend reported for that session — a sidecar the backend owns is the backend's to remove, and a recursive delete here could take a directory.
- **The browser bundle is ~1 MB (205 KB gzipped).** The emulator is most of it. The client module loader serves one file per plugin with no code splitting, so it cannot be deferred until the Terminal panel opens.
- **`--dsw-alias-label-error` is not used here.** ui-theme declares no such token, though three harness stylesheets reference it; this package uses `--dsw-alias-state-error-primary`, and `tests/styles.spec.ts` fails on any token ui-theme does not declare.

## Verification

Every panel was exercised against a running `dsh web` before release: the git reading, a per-file patch, staging one file, unstaging it, and a real commit against a real repository — verified with `git log`, then undone, a `/bin/zsh` shell running a command and rendering its output, the file listing and a text preview, a `.claude/launch.json` dev server started and shown in the frame plus a deliberately failing one whose stderr opened the log view, the empty task list, and the Delete confirmation. `tests/` covers the porcelain parser against real `git status -z` output, the launch-file parser and merge, the screen model's control vocabulary, the path-containment guard, the generated wire contract end to end, the layer placement that keeps a submenu on screen, the terminal group's tab bookkeeping, and every design token the stylesheets name.

An adversarial audit of the finished package found 35 candidate defects; the confirmed ones are fixed here, including a path-traversal hole in the untracked-diff path (`git diff --no-index` applies no repository containment of its own), a duplicated task-output buffer, a preview poll loop that never stopped on a failed server, and the settings fallback described above.

## License

MIT
