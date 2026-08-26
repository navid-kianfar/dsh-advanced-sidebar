import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import TYPERT_REMOTE from '../generated/typert.remote-client.js'

/**
 * `generated/` is authored to the harness generator's format rather than produced by a compiler
 * this package can run, so nothing else proves it describes the Host it ships with. These
 * assertions are that proof: every declared endpoint has a descriptor, every descriptor is
 * well-formed, and each one's schemas accept the values its Host method actually exchanges.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOST_SOURCE = readFileSync(new URL('src/host/index.ts', `file://${ROOT}`), 'utf8')

/** The endpoint names `src/host/index.ts` decorates. */
const DECLARED = [...HOST_SOURCE.matchAll(/@Remote\('([^']+)'\)/g)].map(match => match[1])

/** Descriptors, typed loosely because the artifact is plain data with no compile-time face. */
interface Descriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: string }
  parameters: { name: string; wire: string; source: string; codec: { mode: string; typeSymbol: string; schema: { parse(value: unknown): unknown } } }[]
  cancellation?: { parameter: string }
  result: { mode: string; typeSymbol: string; schema: { parse(value: unknown): unknown } }
}

const descriptors = TYPERT_REMOTE.descriptors as unknown as Descriptor[]

/**
 * Find one descriptor.
 * @param method - the endpoint name.
 * @returns the descriptor.
 */
function at(method: string): Descriptor {
  const found = descriptors.find(descriptor => descriptor.method === method)
  if (found === undefined) throw new Error(`no descriptor for ${method}`)
  return found
}

describe('generated Typert contract', () => {
  it('carries exactly the endpoints the Host declares', () => {
    expect([...descriptors.map(descriptor => descriptor.method)].sort())
      .toEqual([...DECLARED].sort())
  })

  it('names this package', () => {
    expect(TYPERT_REMOTE.package).toBe('@achasoft/dsh-advanced-sidebar')
  })

  it('gives every descriptor the identity the gateway routes on', () => {
    for (const descriptor of descriptors) {
      expect(descriptor.service).toBe('advancedSidebar')
      expect(descriptor.namespace).toBe('advancedSidebar')
      expect(descriptor.invocation).toEqual({ kind: 'direct' })
      expect(descriptor.id).toBe(`@achasoft/dsh-advanced-sidebar#advancedSidebar/${descriptor.method}`)
    }
  })

  it('declares each parameter as a strict JSON codec naming a type in this package', () => {
    for (const descriptor of descriptors) {
      for (const parameter of descriptor.parameters) {
        expect(parameter.source).toBe('json')
        expect(parameter.codec.mode).toBe('strict')
        expect(parameter.codec.typeSymbol.startsWith('../src/host/types.ts#')).toBe(true)
        expect(typeof parameter.codec.schema.parse).toBe('function')
      }
      expect(descriptor.result.mode).toBe('strict')
      expect(descriptor.result.typeSymbol.startsWith('../src/host/types.ts#')).toBe(true)
    }
  })

  it('reserves the cancellation parameter for exactly the methods that take a signal', () => {
    const cancellable = descriptors.filter(descriptor => descriptor.cancellation !== undefined)
      .map(descriptor => descriptor.method).sort()
    expect(cancellable).toEqual([
      'deleteSession', 'describe', 'gitDiff', 'gitStatus', 'listEntries', 'openIn', 'readFile',
      'terminalOpen',
    ])
    for (const descriptor of descriptors) {
      if (descriptor.cancellation !== undefined) expect(descriptor.cancellation.parameter).toBe('signal')
    }
  })

  it('accepts a representative request for every endpoint that takes one', () => {
    const requests: Readonly<Record<string, unknown>> = {
      deleteSession: { sessionId: 's-1' },
      gitDiff: { workspacePath: '/w', path: 'a.ts', staged: false, untracked: false },
      gitStatus: { workspacePath: '/w' },
      listEntries: { path: '/w/src', workspacePath: '/w' },
      openIn: { targetId: 'vscode', path: '/w' },
      readFile: { path: '/w/a.ts', workspacePath: '/w' },
      taskKill: { sessionId: 's-1', taskId: 'bash-1' },
      taskOutput: { sessionId: 's-1', taskId: 'bash-1' },
      terminalClose: { terminalId: 't-1' },
      terminalOpen: { workspacePath: '/w', cols: 80, rows: 24 },
      terminalRead: { terminalId: 't-1', fromOffset: 0 },
      terminalSignal: { terminalId: 't-1', signal: 'SIGINT' },
      terminalWrite: { terminalId: 't-1', data: 'ls\r' },
    }
    for (const [method, request] of Object.entries(requests)) {
      const parameter = at(method).parameters[0]
      expect(parameter, `${method} takes a request`).toBeDefined()
      expect(() => parameter?.codec.schema.parse(request), method).not.toThrow()
    }
    expect(at('describe').parameters).toHaveLength(0)
  })

  it('rejects a request whose required field is missing', () => {
    expect(() => at('gitStatus').parameters[0]?.codec.schema.parse({})).toThrow()
    expect(() => at('terminalSignal').parameters[0]?.codec.schema.parse({ terminalId: 't', signal: 'SIGWINCH' }))
      .toThrow()
  })

  it('accepts both branches of every discriminated result', () => {
    const ok: Readonly<Record<string, unknown>> = {
      deleteSession: { ok: true, archived: true, purged: false },
      describe: {
        git: { available: true },
        terminal: { available: true },
        files: { available: true },
        tasks: { available: true, canKill: true, canReadOutput: true },
        openIn: [{ id: 'reveal', label: 'Finder', available: true, kind: 'reveal' }],
        deletion: { canPurge: false, mode: 'archive' },
        readAt: 1,
      },
      gitDiff: { ok: true, path: 'a.ts', patch: '', binary: false, truncated: false },
      gitStatus: {
        ok: true, repositoryRoot: '/w', prefix: '', ahead: 0, behind: 0, detached: false,
        staged: [{ path: 'a.ts', index: 'modified', worktree: 'unmodified', untracked: false, conflicted: false }],
        unstaged: [], untracked: [], conflicted: [], truncated: false, readAt: 1,
      },
      listEntries: {
        ok: true, path: '/w', entries: [{ name: 'a.ts', path: '/w/a.ts', kind: 'file', size: 3 }], truncated: false,
      },
      openIn: { ok: true },
      readFile: { ok: true, path: '/w/a.ts', text: 'x', binary: false, truncated: false, bytes: 1 },
      taskKill: { ok: true, outcome: 'requested' },
      taskOutput: { ok: true, taskId: 'bash-1', readable: true, text: 'done' },
      terminalClose: { ok: true },
      terminalOpen: { ok: true, terminalId: 't-1', shell: '/bin/zsh', cwd: '/w', pid: 2 },
      terminalRead: {
        ok: true, terminalId: 't-1', text: 'x', nextOffset: 1, lossy: false, running: false,
        exitCode: 0, signal: null,
      },
      terminalSignal: { ok: true },
      terminalWrite: { ok: true },
    }
    for (const [method, value] of Object.entries(ok)) {
      expect(() => at(method).result.schema.parse(value), method).not.toThrow()
    }
    const failures: Readonly<Record<string, unknown>> = {
      deleteSession: { ok: false, code: 'unknown-session', message: 'gone' },
      gitDiff: { ok: false, code: 'no-git', message: 'absent' },
      gitStatus: { ok: false, code: 'not-a-repository', message: 'no repo' },
      listEntries: { ok: false, code: 'path-denied', message: 'outside' },
      openIn: { ok: false, code: 'unavailable', message: 'no code' },
      readFile: { ok: false, code: 'not-a-file', message: 'directory' },
      taskKill: { ok: false, code: 'disabled', message: 'off' },
      taskOutput: { ok: false, code: 'no-registry', message: 'absent' },
      terminalClose: { ok: false, code: 'unknown-terminal', message: 'closed' },
      terminalOpen: { ok: false, code: 'limit-reached', message: 'four already' },
      terminalRead: { ok: false, code: 'unknown-terminal', message: 'closed' },
      terminalSignal: { ok: false, code: 'unknown-terminal', message: 'closed' },
      terminalWrite: { ok: false, code: 'spawn-failed', message: 'broken pipe' },
    }
    for (const [method, value] of Object.entries(failures)) {
      expect(() => at(method).result.schema.parse(value), method).not.toThrow()
    }
  })

  it('refuses a result carrying an undeclared failure code', () => {
    expect(() => at('gitStatus').result.schema.parse({ ok: false, code: 'nope', message: 'x' })).toThrow()
  })
})
