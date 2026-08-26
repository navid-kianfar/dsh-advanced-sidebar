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
  /** Show the menu trigger at the sidebar foot, beside Settings. */
  readonly showInSidebar: boolean
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
  /** Panel width in pixels; the drawer clamps it to the viewport at render time. */
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
  /** Wall-clock bound on each `git` invocation. */
  readonly gitTimeoutMs: number
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
  /** The session is live; a running conversation is stopped before it is deleted. */
  | 'live-session'
  /** The registry refused the archive write; the message carries its error. */
  | 'archive-failed'
  /** The artifact was located but could not be removed; the message carries the filesystem error. */
  | 'remove-failed'

/** Settlement of a delete. */
export type DeleteSessionResult =
  | DeleteSessionSuccess
  | { readonly ok: false; readonly code: DeleteSessionFailureCode; readonly message: string }
