# @achasoft/dsh-advanced-sidebar

Advanced sidebar operations for the DeepSeek Harness Web Client: **Changes**, **Terminal**, **Files**, **Background tasks**, **Open in**, **Archive**, and **Delete**, reachable from one menu at the sidebar foot and from the same menu in the open session's header.

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

| Entry | What it opens | What it needs on the Host |
|---|---|---|
| Changes | Uncommitted changes in the session's working directory, with each file's patch on demand | `git` on PATH, `ctx.subprocess`, `ctx.fs` |
| Terminal | An interactive shell of your own, in that directory | `ctx.subprocess`, `ctx.fs` |
| Files | That directory, one level at a time, with a text preview | `ctx.fs` |
| Preview | The workspace's dev server, started and shown in a frame, with its logs | `ctx.subprocess`, `ctx.fs` |
| Background tasks | This session's `ctx.jobs` records, with Stop and the output of a settled one | `ctx.jobs` |
| Open in ▸ | A second browser window, a configured editor, or the operating system's file manager | `ctx.subprocess` for the editors |
| Archive | Hides the session; its log and its accounting slot remain | `ctx.workspaceRegistry` |
| Delete | Archives, and — in `purge` mode — removes the durable session log | `ctx.workspaceRegistry`, `ctx.sessionPersistence` |

An entry whose capability is missing is **disabled with the reason beside it** rather than hidden, so a mistyped `command` or an uninstalled `git` is visible instead of silent. An entry switched off in settings is absent entirely.

The target of every entry is the session's own `cwd`, falling back to its Workspace path. A session started in a subdirectory therefore works there, rather than at a repository root the model is not using.

## What each panel does, and what it deliberately does not

**Changes** is read-only. Staging, discarding, and committing are repository writes whose consequences a sidebar cannot make legible, and each is one keystroke away in the Terminal panel beside it. The reading is `git status --porcelain=v2 --branch -z --untracked-files=all`, parsed in [`src/host/porcelain.ts`](src/host/porcelain.ts); `-z` is what keeps a path containing a space, a quote, or a newline identical between the status reading and the diff request that follows it.

**Terminal** allocates its own shell through `ctx.subprocess.spawnTerminal` — deliberately **not** `ctx.terminals`. That registry's sessions are owner-fenced to an `Agent` and are the model's working terminals; joining them would let a human's keystrokes land in a session the model believes it controls.

The screen is a real terminal emulator (`@xterm/xterm`), and that is why the browser bundle is large. It is not a preference: an interactive shell redraws its prompt with cursor addressing on every keystroke, and a hand-rolled screen model renders a login shell's prompt as overwritten fragments — verified, then replaced. Colour, line editing, history recall, and full-screen programs come with the emulator. Ctrl+C is intercepted and delivered as a **signal to the foreground process group** rather than as a byte, which is the difference between interrupting a running command and doing nothing.

Output is polled, not pushed: an out-of-tree plugin has no host-to-client push channel, so the panel holds the whole-stream offset it has already written into the emulator and asks for whatever came after it. That offset is also what makes a reopened panel replay the retained scrollback.

There is no resize: the subprocess seam exposes none. The emulator follows the drawer so rendered rows stay readable, but the *shell* keeps the size it was allocated at; **Restart** allocates one at the new size.

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

The frame is a plain `<iframe>` with viewport presets (desktop, tablet, mobile) scaled to the drawer, and an editable address bar so you can navigate into a route rather than only the root. Two controls are permanent rather than error states:

- **Logs** — stdout and stderr interleaved in arrival order, read by the same caller-owned offset the Terminal panel uses. A server that failed to start has nothing to put in the frame and its stderr is the only place the reason exists, so a failed start opens the log view itself.
- **Open in a new window** — a page can refuse to be framed (`X-Frame-Options`, `frame-ancestors`), and cross-origin framing gives the panel no way to detect that: the load event fires either way. The escape hatch is therefore always present instead of appearing after a failure nothing can observe.

Stopping is `SIGTERM` then `SIGKILL` on the whole process tree after `previewGraceMs`, so a dev server's own child processes go with it. Starting a configuration that is already running replaces it rather than racing it for the port, and every server is stopped when the plugin unloads.

**Background tasks** does not fetch its list. The Host already pushes `session/jobs` frames that the Web Client folds into `jobsBySession`, so the panel reads the same live data the session header's job chip reads. Only Stop and output cross this plugin's endpoint:

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

Every deployment-varying choice is a `config` field on the `advanced-sidebar` row in [`cordis.patch.yml`](cordis.patch.yml) — placement, which entries exist, drawer width, delete mode, task permissions, git bounds, the shell, the terminal count, the file-preview bounds, and the Open in targets. The card edits all of them except the target list, which stays in `cordis.yml` where a command and its arguments can be written properly; the card shows each target's **availability on this Host**, which the file cannot state.

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

Four slot registrations: `sidebar.footer.action`, `conversation.session.header.utilities`, `shell.overlay` (the drawer and the Delete confirmation), and `settings.plugin.item`. They have no common React ancestor, so what a person opened lives in a controller this package owns and hands to each registration through its inject face.

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
- **Stopping a task suppresses its model notice.** See Background tasks above; `allowTaskKill: false` removes the verb.
- **Purge removes one artifact.** Exactly the path the persistence backend reported for that session — a sidecar the backend owns is the backend's to remove, and a recursive delete here could take a directory.
- **The browser bundle is ~1 MB (205 KB gzipped).** The emulator is most of it. The client module loader serves one file per plugin with no code splitting, so it cannot be deferred until the Terminal panel opens.
- **`--dsw-alias-label-error` is not used here.** ui-theme declares no such token, though three harness stylesheets reference it; this package uses `--dsw-alias-state-error-primary`, and `tests/styles.spec.ts` fails on any token ui-theme does not declare.

## Verification

Every panel was exercised against a running `dsh web` before release: the git reading and a per-file patch against a real repository, a `/bin/zsh` shell running a command and rendering its output, the file listing and a text preview, a `.claude/launch.json` dev server started and shown in the frame plus a deliberately failing one whose stderr opened the log view, the empty task list, and the Delete confirmation. `tests/` covers the porcelain parser against real `git status -z` output, the launch-file parser and merge, the screen model's control vocabulary, the path-containment guard, the generated wire contract end to end, and every design token the stylesheets name.

An adversarial audit of the finished package found 35 candidate defects; the confirmed ones are fixed here, including a path-traversal hole in the untracked-diff path (`git diff --no-index` applies no repository containment of its own), a duplicated task-output buffer, a preview poll loop that never stopped on a failed server, and the settings fallback described above.

## License

MIT
