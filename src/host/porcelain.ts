/**
 * Pure parser for `git status --porcelain=v2 --branch -z`.
 *
 * Kept apart from the command runner so the format — which is the only part of the git integration
 * with edge cases worth testing (renames carry two paths, `-z` terminates every line including the
 * headers, and a path may contain any byte but NUL) — is exercised without a subprocess.
 * @module @achasoft/dsh-advanced-sidebar/host/porcelain
 */

import type { GitFileChange, GitFileState } from './types.ts'

/** Branch facts from the `# branch.*` headers, all optional because an unborn branch has none. */
export interface PorcelainBranch {
  /** Value of `# branch.head`, unless it is the literal `(detached)`. */
  branch?: string
  /** Value of `# branch.upstream`. */
  upstream?: string
  /** First figure of `# branch.ab`. */
  ahead: number
  /** Second figure of `# branch.ab`, as a positive count. */
  behind: number
  /** True when `# branch.head` is `(detached)`. */
  detached: boolean
}

/** Everything one status reading yields, before the caller groups or truncates it. */
export interface PorcelainStatus {
  /** Branch position. */
  branch: PorcelainBranch
  /** Every changed path in git's own order. */
  changes: GitFileChange[]
}

/**
 * `--porcelain=v2` status letters. `.` is git's spelling of "nothing to report in this index",
 * which is why {@link GitFileState} carries `unmodified` rather than leaving the field absent.
 */
const STATE_BY_LETTER: Readonly<Record<string, GitFileState>> = {
  '.': 'unmodified',
  'M': 'modified',
  'T': 'typechange',
  'A': 'added',
  'D': 'deleted',
  'R': 'renamed',
  'C': 'copied',
  'U': 'conflicted',
}

/**
 * Map one status letter.
 * @param letter - a single `XY` character.
 * @returns the state, or `modified` for a letter a newer git introduced after this parser.
 */
function state(letter: string | undefined): GitFileState {
  if (letter === undefined) return 'unmodified'
  return STATE_BY_LETTER[letter] ?? 'modified'
}

/**
 * Split one `1`/`2`/`u` record into its space-separated fields plus the trailing path.
 *
 * The path is the remainder after a fixed field count, never a split result: a path may contain
 * spaces, and splitting it would silently truncate every such file to its first word.
 * @param record - the record text without its NUL terminator.
 * @param fields - how many space-separated fields precede the path (including the leading type).
 * @returns the fields and the untouched path remainder, or undefined for a malformed record.
 */
function splitRecord(record: string, fields: number): { head: string[]; path: string } | undefined {
  const head: string[] = []
  let at = 0
  for (let index = 0; index < fields; index += 1) {
    const space = record.indexOf(' ', at)
    if (space < 0) return undefined
    head.push(record.slice(at, space))
    at = space + 1
  }
  const path = record.slice(at)
  return path === '' ? undefined : { head, path }
}

/**
 * Parse the `# branch.ab +A -B` header.
 * @param value - the header's value text.
 * @returns ahead and behind counts; zeros when the header is malformed.
 */
function parseAheadBehind(value: string): { ahead: number; behind: number } {
  const match = /^\+(\d+)\s+-(\d+)$/u.exec(value.trim())
  if (match === null) return { ahead: 0, behind: 0 }
  return { ahead: Number(match[1]), behind: Number(match[2]) }
}

/**
 * Parse one complete `--porcelain=v2 --branch -z` payload.
 *
 * Unknown record types are skipped rather than rejected: git adds record kinds over time, and a
 * reading that lists every change it understood is more useful than one that refuses the whole
 * repository because a future git emitted a line this parser has not met.
 * @param payload - git's stdout, verbatim.
 * @returns the branch facts and every parsed change.
 */
export function parsePorcelainV2(payload: string): PorcelainStatus {
  const branch: PorcelainBranch = { ahead: 0, behind: 0, detached: false }
  const changes: GitFileChange[] = []
  // Every line is NUL-terminated under `-z`, so the final split element is an empty tail.
  const chunks = payload.split('\0')
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    if (chunk === undefined || chunk === '') continue

    if (chunk.startsWith('# ')) {
      const space = chunk.indexOf(' ', 2)
      const key = space < 0 ? chunk.slice(2) : chunk.slice(2, space)
      const value = space < 0 ? '' : chunk.slice(space + 1)
      if (key === 'branch.head') {
        if (value === '(detached)') branch.detached = true
        else branch.branch = value
      } else if (key === 'branch.upstream') {
        branch.upstream = value
      } else if (key === 'branch.ab') {
        const { ahead, behind } = parseAheadBehind(value)
        branch.ahead = ahead
        branch.behind = behind
      }
      continue
    }

    if (chunk.startsWith('? ')) {
      const path = chunk.slice(2)
      if (path !== '') {
        changes.push({
          path, index: 'unmodified', worktree: 'untracked', untracked: true, conflicted: false,
        })
      }
      continue
    }

    // `!` (ignored) is requested by nobody here: the reading asks for `--untracked-files=all`
    // without `--ignored`, so an ignored record can only appear if a caller changes the argv.
    if (chunk.startsWith('! ')) continue

    if (chunk.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parsed = splitRecord(chunk, 8)
      if (parsed === undefined) continue
      const xy = parsed.head[1] ?? '..'
      changes.push({
        path: parsed.path,
        index: state(xy[0]),
        worktree: state(xy[1]),
        untracked: false,
        conflicted: false,
      })
      continue
    }

    if (chunk.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const parsed = splitRecord(chunk, 9)
      // The original path is its own NUL-terminated field, so it is consumed here whether or not
      // the record itself parsed — leaving it would make it look like a bare untracked record.
      const original = chunks[index + 1]
      index += 1
      if (parsed === undefined) continue
      const xy = parsed.head[1] ?? '..'
      changes.push({
        path: parsed.path,
        ...original === undefined || original === '' ? {} : { oldPath: original },
        index: state(xy[0]),
        worktree: state(xy[1]),
        untracked: false,
        conflicted: false,
      })
      continue
    }

    if (chunk.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parsed = splitRecord(chunk, 10)
      if (parsed === undefined) continue
      changes.push({
        path: parsed.path,
        index: 'conflicted',
        worktree: 'conflicted',
        untracked: false,
        conflicted: true,
      })
    }
  }
  return { branch, changes }
}

/**
 * Whether a change belongs in the staged group — its index state differs from HEAD.
 * @param change - one parsed change.
 * @returns true when a commit right now would record something for this path.
 */
export function isStaged(change: GitFileChange): boolean {
  return !change.untracked && !change.conflicted && change.index !== 'unmodified'
}

/**
 * Whether a change belongs in the unstaged group — its working tree differs from the index.
 * @param change - one parsed change.
 * @returns true when the path has edits no commit would record yet.
 */
export function isUnstaged(change: GitFileChange): boolean {
  return !change.untracked && !change.conflicted && change.worktree !== 'unmodified'
}
