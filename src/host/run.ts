/**
 * One-shot command execution over `ctx.subprocess`, shared by the git reader and the Open in
 * launcher.
 *
 * The subprocess seam applies no defaults, so every disposition, bound, and grace period is stated
 * here from this plugin's own settings — which is also what keeps the two callers' behavior
 * configurable from cordis.yml rather than from constants buried in a runner.
 * @module @achasoft/dsh-advanced-sidebar/host/run
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** Everything one invocation needs; nothing is defaulted. */
export interface CommandSpec {
  /** Executable and arguments; `argv[0]` is a resolved executable path. */
  readonly argv: readonly string[]
  /** Working directory. */
  readonly cwd: string
  /** Wall-clock bound; exceeding it terminates the process tree. */
  readonly timeoutMs: number
  /** In-memory cap per stream, in bytes; overflow keeps the tail. */
  readonly maxBytes: number
  /** TERM-to-KILL grace for the termination escalation. */
  readonly graceMs: number
  /** Explicit environment entries layered over the provider's scrubbed base. */
  readonly env?: Record<string, string>
}

/** Exit facts and collected output of one finished command. */
export interface CommandOutcome {
  /** Exit code; null when the process died from a signal. */
  readonly exitCode: number | null
  /** Terminating signal; null on a normal exit. */
  readonly signal: string | null
  /** Collected stdout. */
  readonly stdout: string
  /** Collected stderr. */
  readonly stderr: string
  /** True when the command was stopped by {@link CommandSpec.timeoutMs}. */
  readonly timedOut: boolean
  /** True when the caller's own signal aborted the command. */
  readonly aborted: boolean
  /**
   * True when stdout exceeded {@link CommandSpec.maxBytes} and only its TAIL was retained.
   *
   * Reported rather than swallowed because it changes what the text means: a caller that then takes
   * the head of this string is showing the middle of the real output, and would label it complete.
   */
  readonly stdoutLossy: boolean
}

/** No filesystem/subprocess capability, or a spawn that never produced a process. */
export class CommandUnavailableError extends Error {
  /**
   * @param message - operator diagnostic naming what was missing.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CommandUnavailableError'
  }
}

/**
 * Read one collect-mode stream in full.
 * @param reader - the stream's offset reader, present by the spawn's own disposition.
 * @returns the retained text and whether the head was dropped to fit the cap.
 */
function drain(reader: SubprocessOutputReader | undefined): { text: string; lossy: boolean } {
  /* v8 ignore next -- both streams are spawned in collect mode, so both readers exist. */
  if (reader === undefined) return { text: '', lossy: false }
  const read = reader.readFrom(0)
  return { text: read.text, lossy: read.lossy }
}

/**
 * Resolve one executable, returning undefined rather than throwing when it is absent.
 * @param ctx - Host context carrying the optional subprocess capability.
 * @param command - executable name or absolute path.
 * @param signal - cancellation for the lookup.
 * @returns the canonical executable path, or undefined when it does not resolve.
 * @throws {CommandUnavailableError} when no subprocess capability is mounted.
 */
export async function resolveCommand(
  ctx: Context, command: string, signal?: AbortSignal,
): Promise<string | undefined> {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new CommandUnavailableError(
      'no subprocess capability is mounted: this deployment composes no @deepseek-ai/dsh-subprocess provider',
    )
  }
  try {
    return await subprocess.resolveExecutable(command, undefined, signal)
  } catch {
    // A command that does not resolve is the ordinary "not installed" answer, and every caller
    // reports it as an unavailable capability rather than as an error.
    return undefined
  }
}

/**
 * Run one command to completion under a timeout.
 * @param ctx - Host context carrying the optional subprocess capability.
 * @param spec - the fully specified invocation.
 * @param signal - the caller's cancellation, distinguished from the timeout in the outcome.
 * @returns exit facts and collected output.
 * @throws {CommandUnavailableError} when no subprocess capability is mounted.
 */
export async function runCommand(
  ctx: Context, spec: CommandSpec, signal?: AbortSignal,
): Promise<CommandOutcome> {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new CommandUnavailableError(
      'no subprocess capability is mounted: this deployment composes no @deepseek-ai/dsh-subprocess provider',
    )
  }
  // Two separate signals rather than one merged controller: which of them fired is the difference
  // between "retry later" and "the caller left", and a merged signal cannot answer that.
  const timeout = AbortSignal.timeout(spec.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const handle = subprocess.spawn({
    argv: spec.argv,
    cwd: spec.cwd,
    stdio: {
      stdin: 'ignore',
      // No spill: these commands are bounded readings whose tail is what a panel shows, and a
      // spill file would be a temporary artifact nobody deletes.
      stdout: { maxBytes: spec.maxBytes },
      stderr: { maxBytes: spec.maxBytes },
    },
    graceMs: spec.graceMs,
    signal: combined,
    ...spec.env === undefined ? {} : { env: spec.env },
  })
  const outcome = await handle.done
  const stdout = drain(handle.collected.stdout)
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout.text,
    stderr: drain(handle.collected.stderr).text,
    timedOut: timeout.aborted,
    aborted: signal?.aborted === true && !timeout.aborted,
    stdoutLossy: stdout.lossy,
  }
}
