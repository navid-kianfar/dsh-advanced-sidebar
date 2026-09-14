/**
 * Wire contract of the `advancedSidebar` Remote namespace, plus the shape of the
 * `advanced-sidebar` settings section both halves address.
 *
 * Every endpoint returns a discriminated result rather than throwing: the RPC gateway erases a
 * business exception into one opaque transport failure, and each panel's next move depends on which
 * class the failure was — a missing `git` binary asks for an install, a denied path asks for a
 * different workspace, and a timeout asks to retry.
 * @module @achasoft/dsh-advanced-sidebar/host
 */

/* --------------------------------------------------------------------------------------------- */
/* Settings                                                                                        */
/* --------------------------------------------------------------------------------------------- */

/** One external application the Open in submenu can hand a path to. */
export interface OpenInEditor {
  /** Stable id used by the Open in request and by a profile patch overriding this row. */
  readonly id: string
  /** Menu text. Deployment-owned, because the same command is called different things per install. */
  readonly label: string
  /** Executable name or absolute path; resolved on the Host, never shell-interpreted. */
  readonly command: string
  /**
   * Arguments placed before the path. An empty list passes the path alone.
   *
   * Mutable, unlike every other field here: this one is validated by a Schemastery `z.array`, whose
   * inferred source type is a mutable array, and a `readonly` element type makes the whole section
   * unassignable to its own schema.
   */
  args: string[]
}

/** What happens to a session's durable log when Delete is confirmed. */
export type DeleteMode = 'archive' | 'purge'

/** The `advanced-sidebar` settings section: everything a deployment or a person can change. */
export interface AdvancedSidebarSettings {
  /** Show the menu trigger in the session header, acting on the open session. */
  readonly showInSessionHeader: boolean
  /** Offer the Git changes entry. */
  readonly showChanges: boolean
  /** Offer the Terminal entry. */
  readonly showTerminal: boolean
  /** Offer the Files entry. */
  readonly showFiles: boolean
  /** Offer the Background tasks entry. */
  readonly showTasks: boolean
  /** Offer the Open in submenu. */
  readonly showOpenIn: boolean
  /** Offer the Archive entry. */
  readonly showArchive: boolean
  /** Offer the Delete entry. */
  readonly showDelete: boolean
  /** Offer the Preview entry. */
  readonly showPreview: boolean
  /**
   * Dock width in pixels, and where a resize is stored. The dock clamps it to what the app frame
   * can spare at render time, so a wide preference is safe on a narrow window.
   */
  readonly panelWidth: number
  /** Ask before Delete commits. */
  readonly confirmDelete: boolean
  /**
   * `archive` hides the session and keeps its log; `purge` also removes the backend's per-session
   * artifact, which no other harness capability can undo.
   */
  readonly deleteMode: DeleteMode
  /** Offer Stop on a live background task. */
  readonly allowTaskKill: boolean
  /** Offer the output of a settled, already-reported background task. */
  readonly showTaskOutput: boolean
  /** Largest number of changed files one status reading returns. */
  readonly gitMaxFiles: number
  /** Largest patch, in bytes, one diff reading returns. */
  readonly gitDiffMaxBytes: number
  /** Wall-clock bound on each `git` invocation that only reads. */
  readonly gitTimeoutMs: number
  /**
   * Wall-clock bound on `git commit`, which is separate because it is the one invocation that runs
   * somebody else's code: a `pre-commit` hook can take far longer than any reading, and killing it
   * mid-run would leave the index locked.
   */
  readonly gitCommitTimeoutMs: number
  /** Offer Stage and Unstage in the Changes panel. */
  readonly allowGitStaging: boolean
  /** Offer Commit in the Changes panel; requires {@link allowGitStaging}. */
  readonly allowGitCommit: boolean
  /** Offer Push in the Changes panel. */
  readonly allowGitPush: boolean
  /**
   * Wall-clock bound on `git push`, separate because it is the one invocation that waits on a
   * network and on a remote's own processing.
   */
  readonly gitPushTimeoutMs: number
  /** Offer the model-written commit message in the Changes panel; requires {@link allowGitCommit}. */
  readonly allowCommitMessageDraft: boolean
  /** System prompt for the drafted commit message; empty uses this plugin's own. */
  readonly commitMessagePrompt: string
  /** Largest staged patch, in bytes, sent to the model when drafting a commit message. */
  readonly commitMessageMaxBytes: number
  /** Shell for the panel terminal; empty resolves `$SHELL`, then the platform default. */
  readonly terminalShell: string
  /** Retained terminal output in characters; the head is dropped past it. */
  readonly terminalScrollback: number
  /** How many panel terminals may be open at once across every workspace. */
  readonly maxTerminals: number
  /** TERM-to-KILL grace when a panel terminal is closed. */
  readonly terminalGraceMs: number
  /** Largest file preview, in bytes, the Files panel will read. */
  readonly filesMaxPreviewBytes: number
  /** Largest number of entries one directory listing returns. */
  readonly filesMaxEntries: number
  /** List dot-prefixed entries in the Files panel. */
  readonly filesShowHidden: boolean
  /** External applications offered under Open in; mutable for the same reason as {@link OpenInEditor.args}. */
  editors: OpenInEditor[]
  /**
   * Launch configurations offered by the Preview panel, merged after any the workspace's own
   * `.claude/launch.json` carries. A name declared in both places is taken from the file, so a
   * repository stays the authority on how to run itself.
   */
  previews: PreviewLaunchConfig[]
  /** Read `.claude/launch.json` from the workspace. */
  previewsFromLaunchFile: boolean
  /** How many preview servers may run at once across every workspace. */
  maxPreviews: number
  /** How long to wait for a started server's port to accept a connection, in milliseconds. */
  previewReadyTimeoutMs: number
  /** Retained preview output in characters; the head is dropped past it. */
  previewScrollback: number
  /** TERM-to-KILL grace when a preview server is stopped. */
  previewGraceMs: number
  /**
   * Largest workspace file a preview mode will hand to the browser, in bytes.
   *
   * Separate from `filesMaxPreviewBytes`, which bounds a TEXT preview rendered inside the panel:
   * this one bounds a media response streamed into a frame, and a video is legitimately far larger
   * than any file worth reading as text. Past it the panel reports the size and offers
   * "open with the default application" instead.
   */
  readonly previewMaxFileBytes: number
  /** Wall-clock bound on one proxied upstream request, in milliseconds. */
  readonly previewProxyTimeoutMs: number
  /**
   * How long an agent command waits for the panel to answer before the tool reports a timeout,
   * in milliseconds. Long enough for a frame load plus an `open`, short enough that a model turn is
   * not spent waiting on a browser tab that is not there.
   */
  readonly previewCommandTimeoutMs: number
  /** How long a bind is trusted after its last poll before the surface is reported as unmounted. */
  readonly previewBindTtlMs: number
}

/* --------------------------------------------------------------------------------------------- */
/* Capability view                                                                                 */
/* --------------------------------------------------------------------------------------------- */

/** Availability of one Host-backed panel, with the reason when it is unavailable. */
export interface CapabilityState {
  /** Whether the panel can do its work on this Host right now. */
  readonly available: boolean
  /** Operator diagnostic shown in place of the panel body; absent while available. */
  readonly reason?: string
  /** Free-form identity of what answers for the capability (`git version 2.45.1`, `/bin/zsh`). */
  readonly detail?: string
}

/** One Open in target as the menu should render it. */
export interface OpenInTargetView {
  /** Matches {@link OpenInEditor.id}, or `reveal` for the operating system's own file manager. */
  readonly id: string
  /** Menu text. */
  readonly label: string
  /** Whether the target resolved on this Host; unavailable targets render disabled, not hidden. */
  readonly available: boolean
  /** `reveal` hands the path to the desktop; `command` launches a resolved executable. */
  readonly kind: 'reveal' | 'command'
}

/** What the browser needs to decide which entries are live before it opens the menu. */
export interface AdvancedSidebarView {
  /** `git` presence and version. */
  readonly git: CapabilityState
  /** Whether a panel terminal can be allocated, and which shell would answer. */
  readonly terminal: CapabilityState
  /** Whether the Host exposes a filesystem this plugin may read. */
  readonly files: CapabilityState
  /** Whether a preview server can be started, and how many are already running. */
  readonly preview: CapabilityState & {
    /** How many preview servers this plugin currently holds open. */
    readonly running: number
    /**
     * Where the same-origin preview routes are, when the Host serves them.
     *
     * Absent means no `webServer` capability is mounted, which is the headless case: the Server and
     * URL modes still work through the frame's own origin, but a workspace file cannot be framed at
     * all and the agent cannot inspect a cross-origin page. The panel says so rather than offering a
     * mode that cannot work.
     */
    readonly surface?: PreviewSurfaceInfo
  }
  /** Whether a job registry is mounted, and what may be done to a record. */
  readonly tasks: CapabilityState & {
    /** A live task can be stopped (registry mounted AND the setting allows it). */
    readonly canKill: boolean
    /** A settled, already-reported task's output can be shown without consuming the model's read. */
    readonly canReadOutput: boolean
  }
  /** Every Open in target in menu order, available or not. */
  readonly openIn: readonly OpenInTargetView[]
  /** Whether Delete can remove the durable artifact, and what it would do today. */
  readonly deletion: {
    /** Whether the session-persistence backend exposes a per-session artifact to remove. */
    readonly canPurge: boolean
    /** The configured mode; `purge` degrades to `archive` when {@link canPurge} is false. */
    readonly mode: DeleteMode
    /** Why purging is unavailable, when it is. */
    readonly reason?: string
  }
  /**
   * The resolved settings section.
   *
   * Carried here because the browser cannot always read it: `ctx.settingsScope` resolves to a real
   * document only on a loopback connection, and answers `unavailable` with no value on every remote
   * Web Client. Without this field the whole surface would decide it was switched off and render
   * nothing. The bound scope stays the authority where it HAS a value — it is live and writable —
   * and this is what the surface falls back to.
   */
  readonly settings: AdvancedSidebarSettings
  /** Epoch ms the view was assembled, so a stale panel can say how old its facts are. */
  readonly readAt: number
}

/* --------------------------------------------------------------------------------------------- */
/* Git                                                                                             */
/* --------------------------------------------------------------------------------------------- */

/** Per-path state in one of git's two indexes. */
export type GitFileState =
  | 'unmodified' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange'
  | 'untracked' | 'ignored' | 'conflicted'

/** One changed path as `git status --porcelain=v2` reported it. */
export interface GitFileChange {
  /** Repository-relative POSIX path — the identity a later diff request repeats. */
  readonly path: string
  /** Source path of a rename or copy. */
  readonly oldPath?: string
  /** State in the index (what a commit would record). */
  readonly index: GitFileState
  /** State in the working tree (what is not staged yet). */
  readonly worktree: GitFileState
  /** True for a path in neither index, reported by `--porcelain=v2`'s `?` records. */
  readonly untracked: boolean
  /** True for an unresolved merge conflict (`u` records). */
  readonly conflicted: boolean
}

/** A repository reading: branch position and the three change groups. */
export interface GitStatusSuccess {
  readonly ok: true
  /** Absolute path of the repository root, which may sit above the workspace directory. */
  readonly repositoryRoot: string
  /** Requested directory relative to {@link repositoryRoot}, POSIX, empty at the root itself. */
  readonly prefix: string
  /** Current branch; absent while detached or on an unborn branch. */
  readonly branch?: string
  /** Configured upstream of {@link branch}. */
  readonly upstream?: string
  /** Commits ahead of {@link upstream}. */
  readonly ahead: number
  /** Commits behind {@link upstream}. */
  readonly behind: number
  /** True while HEAD names a commit rather than a branch. */
  readonly detached: boolean
  /** Paths whose index state differs from HEAD. */
  readonly staged: readonly GitFileChange[]
  /** Tracked paths whose working tree differs from the index. */
  readonly unstaged: readonly GitFileChange[]
  /** Paths git does not track. */
  readonly untracked: readonly GitFileChange[]
  /** Unresolved merge conflicts, listed separately because neither group describes them. */
  readonly conflicted: readonly GitFileChange[]
  /** True when the reading stopped at `gitMaxFiles` and the lists are incomplete. */
  readonly truncated: boolean
  /** What the panel may do to this repository, and who a commit would be authored by. */
  readonly write: GitWriteCapability
  /** Epoch ms of the reading. */
  readonly readAt: number
}

/** Why a git reading could not be produced. */
export type GitFailureCode =
  /** No filesystem capability is mounted, so no path could be resolved. */
  | 'no-filesystem'
  /** `git` is not on this Host. */
  | 'no-git'
  /** The directory is not inside a git repository. */
  | 'not-a-repository'
  /** git ran and exited non-zero; the message carries its stderr. */
  | 'git-failed'
  /** git exceeded `gitTimeoutMs`. */
  | 'timeout'
  /** The caller abandoned the request. */
  | 'cancelled'
  /** The requested path left the workspace it was asked about. */
  | 'path-denied'
  /** The operation is switched off in the advanced-sidebar settings. */
  | 'disabled'
  /** `git commit` was asked for with nothing staged. */
  | 'nothing-staged'
  /** `git commit` was asked for with a blank message. */
  | 'empty-message'
  /** git has no `user.name`/`user.email`, so it has no author to record. */
  | 'no-identity'
  /** The branch has no upstream, so `git push` has no default destination. */
  | 'no-upstream'
  /** HEAD names no branch, so there is nothing to push. */
  | 'detached-head'
  /** No model is configured on this Host, so no message can be drafted. */
  | 'no-model'
  /** The model request failed; the message carries what it said. */
  | 'llm-failed'

/** Whether the repository can be written from the panel, and whether it could commit right now. */
export interface GitWriteCapability {
  /** Staging and unstaging are offered. */
  readonly canStage: boolean
  /** Committing is offered. */
  readonly canCommit: boolean
  /** Pushing is offered. */
  readonly canPush: boolean
  /** The model-written commit message is offered, and a model is mounted to write it. */
  readonly canDraftMessage: boolean
  /**
   * Author identity `git commit` would use, as `Name <email>`.
   *
   * Absent means git has none configured, and a commit would fail with its own long explanation.
   * Reported here so the panel can say so before the button is pressed rather than after.
   */
  readonly author?: string
}

/** A classified git failure, carried as a value. */
export interface GitFailure {
  readonly ok: false
  readonly code: GitFailureCode
  readonly message: string
}

/** Reading of a workspace's git state. */
export type GitStatusResult = GitStatusSuccess | GitFailure

/** Which repository directory to read. */
export interface GitStatusRequest {
  /** Absolute Host directory — the workspace path the panel was opened for. */
  readonly workspacePath: string
}

/** Which version of one path to diff. */
export interface GitDiffRequest {
  /** Absolute Host directory the status reading came from. */
  readonly workspacePath: string
  /** Repository-relative POSIX path, exactly as {@link GitFileChange.path} spelled it. */
  readonly path: string
  /** Diff the index against HEAD rather than the working tree against the index. */
  readonly staged: boolean
  /** The path is untracked, so the patch is synthesized against an empty blob. */
  readonly untracked: boolean
}

/** One unified patch. */
export interface GitDiffSuccess {
  readonly ok: true
  /** Echo of the requested path. */
  readonly path: string
  /** Unified diff text; empty when the two versions are identical. */
  readonly patch: string
  /** True when git reported a binary difference and produced no text. */
  readonly binary: boolean
  /** True when the patch was cut at `gitDiffMaxBytes`. */
  readonly truncated: boolean
}

/** Patch for one path, or a classified failure. */
export type GitDiffResult = GitDiffSuccess | GitFailure

/** Move paths into or out of the index. */
export interface GitStageRequest {
  /** Absolute Host directory the status reading came from. */
  readonly workspacePath: string
  /**
   * Repository-relative POSIX paths, exactly as {@link GitFileChange.path} spelled them.
   *
   * Every one is proved to sit inside the repository before git sees it, and each is passed after
   * `--` as a literal path rather than a pathspec, so neither an option nor a glob can be smuggled
   * through. An empty list is refused.
   */
  readonly paths: readonly string[]
}

/** Settlement of a stage or unstage, carrying the reading that follows it. */
export interface GitWriteSuccess {
  readonly ok: true
  /** The repository state after the write, so the panel needs no second round trip. */
  readonly status: GitStatusSuccess
}

/** Stage/unstage outcome. */
export type GitStageResult = GitWriteSuccess | GitFailure

/** Record the staged changes. */
export interface GitCommitRequest {
  /** Absolute Host directory the status reading came from. */
  readonly workspacePath: string
  /** Commit message; passed as one argument to `-m`, never interpreted by a shell. */
  readonly message: string
  /** Replace the previous commit instead of adding one. */
  readonly amend: boolean
}

/** A recorded commit, with the reading that follows it. */
export interface GitCommitSuccess {
  readonly ok: true
  /** Abbreviated hash of the new commit. */
  readonly commit: string
  /** First line of the recorded message. */
  readonly subject: string
  /** The repository state after the commit. */
  readonly status: GitStatusSuccess
  /**
   * Anything the commit printed on stderr while still succeeding — a hook's advice, a warning.
   * Empty for an ordinary commit.
   */
  readonly notes: string
}

/** Commit outcome. */
export type GitCommitResult = GitCommitSuccess | GitFailure

/** Send the current branch's commits to its remote. */
export interface GitPushRequest {
  /** Absolute Host workspace directory. */
  readonly workspacePath: string
  /**
   * Publish a branch that has no upstream, recording the remote it was pushed to as its upstream.
   * False refuses such a branch instead, because choosing a remote is a decision, not a default.
   */
  readonly setUpstream: boolean
}

/** A completed push, with the reading that follows it. */
export interface GitPushSuccess {
  readonly ok: true
  /** Branch that was pushed. */
  readonly branch: string
  /** Remote it went to. */
  readonly remote: string
  /** True when this push is what gave the branch its upstream. */
  readonly published: boolean
  /** The repository state after the push; its `ahead` is what proves the push landed. */
  readonly status: GitStatusSuccess
  /** What git printed while succeeding — the ref update lines, and any remote advice. */
  readonly notes: string
}

/** Push outcome. */
export type GitPushResult = GitPushSuccess | GitFailure

/** Ask a model to write a commit message for what is staged. */
export interface GitCommitMessageRequest {
  /** Absolute Host workspace directory. */
  readonly workspacePath: string
  /**
   * Draft for an amend, which describes the previous commit's content as well as the index. False
   * describes the index alone.
   */
  readonly amend: boolean
}

/** A drafted commit message. */
export interface GitCommitMessageSuccess {
  readonly ok: true
  /** The message, ready to be edited before it is recorded. */
  readonly message: string
  /** Provider route that wrote it, so the panel can say which model answered. */
  readonly model: string
  /** True when the patch was cut at `commitMessageMaxBytes` before the model saw it. */
  readonly truncated: boolean
}

/** Draft outcome. */
export type GitCommitMessageResult = GitCommitMessageSuccess | GitFailure

/* --------------------------------------------------------------------------------------------- */
/* Terminal                                                                                        */
/* --------------------------------------------------------------------------------------------- */

/** Open a panel terminal in one workspace. */
export interface TerminalOpenRequest {
  /** Absolute Host directory to start in. */
  readonly workspacePath: string
  /** Initial column count, measured from the rendered panel. */
  readonly cols: number
  /** Initial row count, measured from the rendered panel. */
  readonly rows: number
}

/** An allocated panel terminal. */
export interface TerminalOpenSuccess {
  readonly ok: true
  /** Handle repeated by every later read, write, and close. */
  readonly terminalId: string
  /** Executable that was started. */
  readonly shell: string
  /** Directory the shell started in. */
  readonly cwd: string
  /** Top-level terminal process id. */
  readonly pid: number
}

/** Why a terminal operation failed. */
export type TerminalFailureCode =
  /** No subprocess capability is mounted. */
  | 'no-subprocess'
  /** No filesystem capability is mounted, so the working directory could not be resolved. */
  | 'no-filesystem'
  /** The shell could not be started; the message carries the substrate error. */
  | 'spawn-failed'
  /** The handle names no terminal this plugin owns — usually one already closed. */
  | 'unknown-terminal'
  /** The requested directory left the workspace, or does not exist. */
  | 'path-denied'
  /** `maxTerminals` panel terminals are already open. */
  | 'limit-reached'
  /** The plugin is unloading, so no new terminal will be allocated. */
  | 'closed'

/** A classified terminal failure, carried as a value. */
export interface TerminalFailure {
  readonly ok: false
  readonly code: TerminalFailureCode
  readonly message: string
}

/** Allocation outcome. */
export type TerminalOpenResult = TerminalOpenSuccess | TerminalFailure

/** Read terminal output from a caller-owned byte offset. */
export interface TerminalReadRequest {
  /** Handle from {@link TerminalOpenSuccess}. */
  readonly terminalId: string
  /** Whole-stream character offset to resume from; `0` reads the retained scrollback. */
  readonly fromOffset: number
}

/** Terminal output plus the process state at read time. */
export interface TerminalReadSuccess {
  readonly ok: true
  /** Echo of the handle. */
  readonly terminalId: string
  /** Output text from the requested offset. */
  readonly text: string
  /** Whole-stream character offset to resume from on the next read. */
  readonly nextOffset: number
  /** True when the requested offset had already fallen out of the retained scrollback. */
  readonly lossy: boolean
  /** True while the shell is alive. */
  readonly running: boolean
  /** Exit code once the shell has closed; null when it died from a signal. */
  readonly exitCode?: number | null
  /** Terminating signal once the shell has closed. */
  readonly signal?: string | null
}

/** Read outcome. */
export type TerminalReadResult = TerminalReadSuccess | TerminalFailure

/** Send keystrokes to a terminal. */
export interface TerminalWriteRequest {
  /** Handle from {@link TerminalOpenSuccess}. */
  readonly terminalId: string
  /** Text delivered verbatim; the caller supplies its own newlines and control bytes. */
  readonly data: string
}

/** Deliver a signal to a terminal's foreground process group. */
export interface TerminalSignalRequest {
  /** Handle from {@link TerminalOpenSuccess}. */
  readonly terminalId: string
  /** Signal to deliver; the set the terminal primitive accepts. */
  readonly signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'
}

/** Close a terminal. */
export interface TerminalCloseRequest {
  /** Handle from {@link TerminalOpenSuccess}. */
  readonly terminalId: string
}

/** Settlement of a write, signal, or close. */
export type TerminalAckResult = { readonly ok: true } | TerminalFailure

/* --------------------------------------------------------------------------------------------- */
/* Files                                                                                           */
/* --------------------------------------------------------------------------------------------- */

/** One child of a listed directory. */
export interface DirectoryEntryView {
  /** Basename inside the listed directory. */
  readonly name: string
  /** Absolute Host path — the panel never joins path segments itself. */
  readonly path: string
  /** What the child is; `other` covers sockets, devices, and anything else not opened as text. */
  readonly kind: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the backend reports one. */
  readonly size?: number
}

/** List one directory level inside a workspace. */
export interface ListEntriesRequest {
  /** Absolute Host directory to list. */
  readonly path: string
  /** Absolute workspace directory the listing must stay inside. */
  readonly workspacePath: string
}

/** One directory level. */
export interface ListEntriesSuccess {
  readonly ok: true
  /** Absolute path of the listed directory. */
  readonly path: string
  /** Absolute path of the parent, absent at the workspace root — the panel does not climb out. */
  readonly parent?: string
  /** Children, directories first and then files, each group name-sorted. */
  readonly entries: readonly DirectoryEntryView[]
  /** True when the listing was cut at `filesMaxEntries`. */
  readonly truncated: boolean
}

/** Directory level, or a classified failure. */
export type ListEntriesResult = ListEntriesSuccess | ReadFileFailure

/** Read one file for the Files panel preview. */
export interface ReadFileRequest {
  /** Absolute Host path. */
  readonly path: string
  /** Absolute workspace directory the path must stay inside. */
  readonly workspacePath: string
}

/** A file preview. */
export interface ReadFileSuccess {
  readonly ok: true
  /** Echo of the requested path. */
  readonly path: string
  /** Decoded text; empty when {@link binary} is true. */
  readonly text: string
  /** True when the file's leading bytes contain a NUL, so it is not shown as text. */
  readonly binary: boolean
  /** True when the read stopped at `filesMaxPreviewBytes`. */
  readonly truncated: boolean
  /** Total size on disk in bytes. */
  readonly bytes: number
}

/** Why a preview could not be produced. */
export type ReadFileFailureCode =
  /** No filesystem capability is mounted. */
  | 'no-filesystem'
  /** The path left the workspace directory. */
  | 'path-denied'
  /** Nothing is at the path, or it is not a regular file. */
  | 'not-a-file'
  /** The filesystem refused the read; the message carries its error. */
  | 'read-failed'

/** A classified preview failure, carried as a value. */
export interface ReadFileFailure {
  readonly ok: false
  readonly code: ReadFileFailureCode
  readonly message: string
}

/** Preview outcome. */
export type ReadFileResult = ReadFileSuccess | ReadFileFailure

/* --------------------------------------------------------------------------------------------- */
/* Open in                                                                                         */
/* --------------------------------------------------------------------------------------------- */

/** Hand one path to an external application. */
export interface OpenInRequest {
  /** Matches {@link OpenInTargetView.id}. */
  readonly targetId: string
  /** Absolute Host path to open. */
  readonly path: string
}

/** Why an external open failed. */
export type OpenInFailureCode =
  /** No configured target carries the requested id. */
  | 'unknown-target'
  /** The target's command does not resolve on this Host. */
  | 'unavailable'
  /** The command started and failed; the message carries its stderr. */
  | 'launch-failed'
  /** The path does not exist. */
  | 'path-denied'
  /** The launch exceeded its grace period. */
  | 'timeout'

/** Settlement of an external open. */
export type OpenInResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: OpenInFailureCode; readonly message: string }

/* --------------------------------------------------------------------------------------------- */
/* Background tasks                                                                                */
/* --------------------------------------------------------------------------------------------- */

/** Stop one live background task. */
export interface TaskKillRequest {
  /** Session that owns the task; the registry fences access on it. */
  readonly sessionId: string
  /** Registry-issued job id. */
  readonly taskId: string
}

/** Why a task operation failed. */
export type TaskFailureCode =
  /** No job registry is mounted. */
  | 'no-registry'
  /** The setting that gates this operation is off. */
  | 'disabled'
  /** No live agent answers for the session, so the registry would refuse the caller. */
  | 'unknown-session'
  /** The registry knows no such task for that owner. */
  | 'unknown-task'
  /** The registry refused; the message carries its error. */
  | 'registry-refused'

/** A classified task failure, carried as a value. */
export interface TaskFailure {
  readonly ok: false
  readonly code: TaskFailureCode
  readonly message: string
}

/** Settlement of a stop request. */
export type TaskKillResult =
  | { readonly ok: true; readonly outcome: 'requested' | 'already-finished' }
  | TaskFailure

/** Read one settled task's output. */
export interface TaskOutputRequest {
  /** Session that owns the task. */
  readonly sessionId: string
  /** Registry-issued job id. */
  readonly taskId: string
}

/** A task's output, or the reason it is withheld. */
export interface TaskOutputSuccess {
  readonly ok: true
  /** Echo of the task id. */
  readonly taskId: string
  /**
   * Whether {@link text} carries the output.
   *
   * False while the registry has not marked the record reported: reading a job's stream CONSUMES
   * the model's own delta, so a live task's output is withheld rather than stolen.
   */
  readonly readable: boolean
  /** Accumulated output; empty while {@link readable} is false. */
  readonly text: string
  /** Why the output is withheld; absent while {@link readable} is true. */
  readonly reason?: string
}

/** Output outcome. */
export type TaskOutputResult = TaskOutputSuccess | TaskFailure

/* --------------------------------------------------------------------------------------------- */
/* Session deletion                                                                                */
/* --------------------------------------------------------------------------------------------- */

/** Delete one session. */
export interface DeleteSessionRequest {
  /** Session to remove. */
  readonly sessionId: string
}

/** What Delete actually did. */
export interface DeleteSessionSuccess {
  readonly ok: true
  /** True when the session was added to the registry-global archive set. */
  readonly archived: boolean
  /** True when the persistence backend's per-session artifact was removed. */
  readonly purged: boolean
  /** Absolute path of the removed artifact, when one was removed. */
  readonly artifactPath?: string
  /** Why the artifact survived, when `deleteMode` was `purge` and it did. */
  readonly purgeSkippedReason?: string
}

/** Why a delete could not be committed. */
export type DeleteSessionFailureCode =
  /** The Delete entry is switched off in settings. */
  | 'disabled'
  /** No workspace registry is mounted, so the session could not be hidden. */
  | 'no-registry'
  /** Neither the live store nor persistence knows the id. */
  | 'unknown-session'
  /** The registry refused the archive write; the message carries its error. */
  | 'archive-failed'
  /** The artifact was located but could not be removed; the message carries the filesystem error. */
  | 'remove-failed'

/** Settlement of a delete. */
export type DeleteSessionResult =
  | DeleteSessionSuccess
  | { readonly ok: false; readonly code: DeleteSessionFailureCode; readonly message: string }

/* --------------------------------------------------------------------------------------------- */
/* Preview                                                                                         */
/* --------------------------------------------------------------------------------------------- */

/**
 * One launch configuration: how to start something and where to look at it.
 *
 * The field names are Claude Code's `.claude/launch.json` vocabulary on purpose. A repository that
 * already carries that file gets a working Preview panel with no second configuration to write, and
 * a repository that does not can put the same rows under `previews` in cordis.yml.
 */
export interface PreviewLaunch {
  /** Unique name inside one workspace; the panel's picker shows it and every request repeats it. */
  readonly name: string
  /** Executable to run. Absent makes the row attach-only: it opens {@link url} and starts nothing. */
  readonly runtimeExecutable?: string
  /** Arguments for {@link runtimeExecutable}. */
  readonly runtimeArgs?: readonly string[]
  /** Port the server listens on; readiness is a TCP connect to it. */
  readonly port?: number
  /** Where to point the frame. Absent with a port means `http://127.0.0.1:<port>`. */
  readonly url?: string
  /** Directory to run in, relative to the workspace. Absent runs at the workspace root. */
  readonly cwd?: string
  /** Extra environment entries for the child. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * A launch configuration as a `cordis.yml` row states it.
 *
 * Structurally {@link PreviewLaunch} with mutable members: a Schemastery `z.array`/`z.object` infers
 * mutable source types, and a `readonly` member makes the whole section unassignable to its own
 * schema. The Host reads both through {@link PreviewLaunch}, which this satisfies.
 */
export interface PreviewLaunchConfig {
  /** Unique name inside one workspace. */
  name: string
  /** Executable to run; empty makes the row attach-only. */
  runtimeExecutable: string
  /** Arguments for the executable. */
  runtimeArgs: string[]
  /** Port readiness is probed on; `0` means the row has none. */
  port: number
  /** Where to point the frame; empty derives it from the port. */
  url: string
  /** Directory to run in, relative to the workspace; empty runs at the root. */
  cwd: string
}

/** Where one launch configuration came from, so the panel can say which file to edit. */
export type PreviewOrigin = 'launch-json' | 'settings'

/** Lifecycle of one preview server. */
export type PreviewState =
  /** Nothing is running for this configuration. */
  | 'stopped'
  /** The process started; the port has not accepted a connection yet. */
  | 'starting'
  /** The port accepts connections, or the row is attach-only. */
  | 'ready'
  /** The process exited on its own. */
  | 'exited'
  /** The process could not be started, or readiness timed out. */
  | 'failed'

/** One configuration as the panel should render it. */
export interface PreviewServerView {
  /** Handle for every later request; absent while nothing has been started for this row. */
  readonly serverId?: string
  /** Echo of {@link PreviewLaunch.name}. */
  readonly name: string
  /** Which file the row came from. */
  readonly origin: PreviewOrigin
  /** True when the row starts a process rather than only opening a URL. */
  readonly startable: boolean
  /** Current lifecycle state. */
  readonly state: PreviewState
  /** Where to point the frame, once it is known. */
  readonly url?: string
  /** Port readiness is probed on. */
  readonly port?: number
  /** Top-level process id while one is running. */
  readonly pid?: number
  /** Exit code once the process has ended. */
  readonly exitCode?: number | null
  /** Why the row is `failed`, or why it cannot be started. */
  readonly detail?: string
  /** Epoch ms the process started. */
  readonly startedAt?: number
}

/** List the configurations one workspace offers. */
export interface PreviewListRequest {
  /** Absolute Host workspace directory. */
  readonly workspacePath: string
}

/** Every configuration plus where they were read from. */
export interface PreviewListSuccess {
  readonly ok: true
  /** Configurations in file order, settings rows after launch.json rows. */
  readonly servers: readonly PreviewServerView[]
  /** Absolute path of the launch file that was read, when one existed. */
  readonly launchFile?: string
  /** Why the launch file was ignored, when one existed but could not be used. */
  readonly launchFileError?: string
}

/** Why a preview request failed. */
export type PreviewFailureCode =
  /** No subprocess capability is mounted. */
  | 'no-subprocess'
  /** No filesystem capability is mounted. */
  | 'no-filesystem'
  /** The workspace path, or a configuration's `cwd`, left the workspace or does not exist. */
  | 'path-denied'
  /** No configuration carries the requested name. */
  | 'unknown-server'
  /** The row names no executable, so there is nothing to start. */
  | 'not-startable'
  /** The executable does not resolve on this Host. */
  | 'unavailable'
  /** The process could not be spawned; the message carries the substrate error. */
  | 'spawn-failed'
  /** `maxPreviews` servers are already running. */
  | 'limit-reached'
  /** The plugin is unloading, so no new server will be started. */
  | 'closed'

/** A classified preview failure, carried as a value. */
export interface PreviewFailure {
  readonly ok: false
  readonly code: PreviewFailureCode
  readonly message: string
}

/** Configuration list, or a classified failure. */
export type PreviewListResult = PreviewListSuccess | PreviewFailure

/** Start one configuration. */
export interface PreviewStartRequest {
  /** Absolute Host workspace directory. */
  readonly workspacePath: string
  /** Which configuration to start. */
  readonly name: string
}

/** Start outcome; the row is `starting` until its port accepts. */
export type PreviewStartResult =
  | { readonly ok: true; readonly server: PreviewServerView }
  | PreviewFailure

/** Stop one running server. */
export interface PreviewStopRequest {
  /** Handle from {@link PreviewServerView.serverId}. */
  readonly serverId: string
}

/** Settlement of a stop. */
export type PreviewStopResult = { readonly ok: true } | PreviewFailure

/** Read one server's output from a caller-owned offset. */
export interface PreviewLogsRequest {
  /** Handle from {@link PreviewServerView.serverId}. */
  readonly serverId: string
  /** Whole-stream character offset to resume from; `0` reads the retained buffer. */
  readonly fromOffset: number
}

/** Output plus the state at read time, so the panel needs one poll rather than two. */
export interface PreviewLogsSuccess {
  readonly ok: true
  /** Echo of the handle. */
  readonly serverId: string
  /** Combined stdout and stderr, in arrival order, from the requested offset. */
  readonly text: string
  /** Whole-stream character offset to resume from on the next read. */
  readonly nextOffset: number
  /** True when the requested offset had already fallen out of the retained buffer. */
  readonly lossy: boolean
  /** The server's state at read time. */
  readonly server: PreviewServerView
}

/** Log read, or a classified failure. */
export type PreviewLogsResult = PreviewLogsSuccess | PreviewFailure

/* --------------------------------------------------------------------------------------------- */
/* Same-origin preview serving                                                                     */
/* --------------------------------------------------------------------------------------------- */

/**
 * How the browser should present one workspace file.
 *
 * The kinds are the browser's own vocabulary on purpose, not MIME types: `iframe` covers HTML,
 * `markdown` covers a text file this panel renders itself, `image`/`media`/`pdf` are handed
 * straight to a native element, `text` is shown in the monospace reader, and `other` is the honest
 * "there is nothing to render here" state that still offers the file's size and its OS application.
 */
export type PreviewFileKind = 'iframe' | 'markdown' | 'image' | 'media' | 'pdf' | 'text' | 'other'

/** What one workspace file is, and where it can be framed from. */
export interface PreviewFileInfo {
  /** Absolute Host path that was resolved and contained. */
  readonly path: string
  /** Basename, for a title. */
  readonly name: string
  /** How the browser should present it. */
  readonly kind: PreviewFileKind
  /** MIME type for the frame's response, or `text/plain` for a kind that is never framed. */
  readonly contentType: string
  /** Size on disk in bytes. */
  readonly bytes: number
  /**
   * Whether the file is small enough for `previewMaxFileBytes`.
   *
   * A file over the cap is reported, not refused: the panel shows the size and the OS application,
   * which is more useful than an error about a limit nobody can see.
   */
  readonly withinLimit: boolean
  /**
   * Same-origin URL the file can be framed from, when the Host serves files.
   *
   * Absent when no `webServer` is mounted; then only the non-framed kinds are offered.
   */
  readonly url?: string
  /**
   * Opaque token that changes when the file's content or size does.
   *
   * The panel re-reads it on a quiet poll and reloads the frame when it moves, which is what makes
   * an edit on disk show up without a manual refresh. Deliberately not a timestamp: a backend may
   * not expose one, and a token is the interface `ctx.fs` already offers.
   */
  readonly token: string
  /** True when the file is a regular file; a directory or a socket is reported as `other`. */
  readonly regular: boolean
}

/** Why a file could not be described. */
export type PreviewFileFailureCode =
  /** No filesystem capability is mounted. */
  | 'no-filesystem'
  /** The workspace or the path left the workspace. */
  | 'path-denied'
  /** Nothing is at the path, or it is not a regular file. */
  | 'not-a-file'
  /** The filesystem refused the metadata read; the message carries its error. */
  | 'read-failed'

/** A classified file-info failure, carried as a value. */
export interface PreviewFileFailure {
  readonly ok: false
  readonly code: PreviewFileFailureCode
  readonly message: string
}

/** File metadata, or a classified failure. */
export type PreviewFileInfoResult = ({ readonly ok: true } & PreviewFileInfo) | PreviewFileFailure

/** Describe one workspace file for the Preview panel. */
export interface PreviewFileInfoRequest {
  /** Absolute Host workspace directory the path must stay inside. */
  readonly workspacePath: string
  /** Absolute Host path, or a path relative to the workspace — the panel sends what it has. */
  readonly path: string
}

/** Where an agent asked the panel to point itself. */
export type PreviewRequestedMode = 'server' | 'file' | 'url' | 'scratchpad'

/** Ask one panel: where are you, and can you take a command? */
export interface PreviewBindRequest {
  /** Identifies this browser tab, so commands reach the panel that answered last. */
  readonly clientId: string
  /** The session whose panel this is. */
  readonly sessionId: string
  /** Which mode the panel is showing. */
  readonly mode: PreviewRequestedMode
  /** The file being previewed, when the mode is `file`. */
  readonly filePath?: string
  /** The absolute workspace every path this panel sends must stay inside. */
  readonly workspacePath?: string
  /** What the mode is currently pointing the frame at, when it points anywhere. */
  readonly url?: string
  /** True when the frame's document is same-origin with the GUI, so the agent may inspect it. */
  readonly inspectable: boolean
  /** Frame viewport height in CSS pixels. */
  readonly width: number
  /** Frame viewport height in CSS pixels. */
  readonly height: number
}

/** One class of result an agent command can produce. */
export type PreviewResultKind =
  | 'open' | 'dom' | 'eval' | 'console' | 'click' | 'input' | 'reload' | 'resize' | 'close'

/** One element of a DOM reading. */
export interface PreviewDomNode {
  /** Lower-case tag name. */
  readonly tag: string
  /** `id` and `class` as one readable selector fragment, empty when the element has neither. */
  readonly selector: string
  /** The element's own direct text, collapsed and cut. */
  readonly text: string
  /** Computed `display`. */
  readonly display: string
  /** Rendered border box in CSS pixels, relative to the frame's viewport. */
  readonly box: { x: number; y: number; width: number; height: number }
  /** Nesting depth below the requested root. */
  readonly depth: number
}

/** What one `dom` command answered. */
export interface PreviewDomResult {
  readonly kind: 'dom'
  /** The selector the reading was taken from; empty means the document element. */
  readonly selector: string
  /** The frame's inner size in CSS pixels. */
  readonly viewport: { width: number; height: number }
  /** Matching elements, breadth-first, capped by the tool's own ceiling. */
  readonly nodes: readonly PreviewDomNode[]
  /** The root element's `innerText`, collapsed and cut. */
  readonly text: string
  /** True when the cap cut the walk short. */
  readonly truncated: boolean
  /** The frame's URL as the browser reports it, so a redirect is visible. */
  readonly url: string
}

/** What one `eval` command answered. */
export interface PreviewEvalResult {
  readonly kind: 'eval'
  /**
   * The expression's value, serialized to JSON.
   *
   * A value JSON cannot represent arrives as its `String(value)` — plus a `note` — rather than
   * failing the command: a DOM node or a function is an ordinary thing to evaluate to, and
   * `"null"` with no explanation is a worse answer than `"[object HTMLDivElement]"`.
   */
  readonly value: string
  /** Why the value is not JSON, when it is not. */
  readonly note?: string
  /** True when the value's JSON form was cut at the tool's ceiling. */
  readonly truncated: boolean
}

/** One buffered console line or uncaught error. */
export interface PreviewConsoleEntry {
  /** Which sink produced it. */
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'uncaught' | 'rejection'
  /** The text, with its arguments joined. */
  readonly text: string
  /** Epoch ms, in the frame's own clock. */
  readonly at: number
}

/** What one `console` command answered. */
export interface PreviewConsoleResult {
  readonly kind: 'console'
  /** Entries after the requested cursor, oldest first. */
  readonly entries: readonly PreviewConsoleEntry[]
  /** Cursor to pass to the next `console` command. */
  readonly cursor: number
  /** True when the requested cursor had already fallen out of the retained window. */
  readonly lossy: boolean
}

/** What one `reload`/`resize` command answered. */
export interface PreviewAckResult {
  readonly kind: 'ack'
  /** One line describing what happened, for the tool's text block. */
  readonly detail: string
  /** The viewport after the command, when it changed one. */
  readonly width?: number
  /** The viewport height after the command, when it changed one. */
  readonly height?: number
}

/** Every successful command result. */
export type PreviewCommandResult = PreviewDomResult | PreviewEvalResult | PreviewConsoleResult | PreviewAckResult

/** One command the panel must execute against its frame. */
export interface PreviewCommand {
  /** Echo of the request id, which the result must carry back. */
  readonly id: string
  /** The panel this command belongs to; a panel ignores a command addressed elsewhere. */
  readonly clientId: string
  /** What to do. */
  readonly kind: PreviewResultKind
  /** CSS selector for `dom`, `click`, and `type`. */
  readonly selector?: string
  /** JavaScript source for `eval`. */
  readonly expression?: string
  /** Cursor already consumed by a previous `console`. */
  readonly cursor?: number
  /** Text `type` must set before dispatching its events. */
  readonly text?: string
  /** Key `type` must dispatch after setting the value, e.g. `Enter`. */
  readonly key?: string
  /** Viewport `resize` must apply. */
  readonly width?: number
  /** Viewport height `resize` must apply. */
  readonly height?: number
  /** How long the panel may spend on it before giving up, in milliseconds. */
  readonly timeoutMs: number
}

/** Where an agent asked the panel to point itself, as a control message. */
export interface PreviewOpenMessage {
  /** The panel this message belongs to. */
  readonly clientId: string
  /** Which mode to show. */
  readonly mode: PreviewRequestedMode
  /** Which file to preview, when the mode is `file`. */
  readonly filePath?: string
  /** Which URL to point at, when the mode is `url`. */
  readonly url?: string
  /** Absolute workspace the file path is relative to. */
  readonly workspacePath?: string
}

/** Apply one open request to the panel's own state. */
export interface PreviewControlMessage {
  /** Discriminator for the message union. */
  readonly control: 'open'
  /** What to open. */
  readonly open: PreviewOpenMessage
}

/** Everything the panel must act on after one poll. */
export interface PreviewMessage {
  /** Commands to execute, oldest first. */
  readonly commands: readonly PreviewCommand[]
  /** Mode changes to apply. */
  readonly controls: readonly PreviewControlMessage[]
}

/** Ask for the work queued against one panel. */
export interface PreviewPollRequest {
  /** The panel asking. */
  readonly clientId: string
  /** The session that panel belongs to. */
  readonly sessionId: string
  /** True while a preview is actually mounted; a closed panel stops claiming commands. */
  readonly mounted: boolean
  /** What the panel is doing right now. */
  readonly bind: PreviewBindRequest
}

/** The panel's next work, or a classified failure. */
export interface PreviewPollSuccess {
  readonly ok: true
  /** The work, possibly empty. */
  readonly message: PreviewMessage
  /**
   * Epoch ms after which this poll's bind is stale.
   *
   * The panel echoes nothing back; it simply keeps polling. The Host uses the interval to decide
   * that a tab was closed or navigated away, which is what makes the agent's next command fail with
   * "no preview surface" instead of waiting out its timeout.
   */
  readonly bindTtlMs: number
}

/** Why a panel could not be polled. */
export type PreviewPollFailureCode =
  /** No preview server capability is mounted, so there is nothing to report. */
  | 'no-subprocess'
  /** The plugin is unloading. */
  | 'closed'

/** A classified poll failure, carried as a value. */
export interface PreviewPollFailure {
  readonly ok: false
  readonly code: PreviewPollFailureCode
  readonly message: string
}

/** Poll outcome. */
export type PreviewPollResult = PreviewPollSuccess | PreviewPollFailure

/** Report what one command did. */
export interface PreviewResultRequest {
  /** The panel reporting. */
  readonly clientId: string
  /** Echo of {@link PreviewCommand.id}. */
  readonly id: string
  /** True when the command was executed. */
  readonly ok: boolean
  /** Why it was not, when it was not. */
  readonly error?: string
  /** What it produced, when it was. */
  readonly result?: PreviewCommandResult
  /** Console entries observed since the panel last reported; appended to the Host's buffer. */
  readonly console?: readonly PreviewConsoleEntry[]
}

/** Settlement of a result report. */
export type PreviewResultAck = { readonly ok: true } | PreviewPollFailure

/** Say that a panel is closed, so its queued work is dropped. */
export interface PreviewReleaseRequest {
  /** The panel that closed. */
  readonly clientId: string
}

/** Settlement of a release. */
export type PreviewReleaseResult = { readonly ok: true } | PreviewPollFailure

/** Where the same-origin preview routes live. */
export interface PreviewSurfaceInfo {
  /** Absolute path of the workspace-file route, without a trailing slash. */
  readonly fileRoute: string
  /** Absolute path prefix of the loopback reverse proxy, without a trailing slash. */
  readonly proxyRoute: string
  /** Whether this Host has a `webServer` capability at all. */
  readonly available: boolean
  /** Why it does not, when it does not. */
  readonly reason?: string
}
