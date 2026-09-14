import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewBindings } from '../src/host/ui-bridge.ts'
import type { PreviewBindRequest, PreviewCommand, PreviewConsoleEntry } from '../src/host/types.ts'

/**
 * The agent channel's Host end. Every failure mode here is one a model would otherwise experience as
 * a hung tool call, so each is stated as a test: no panel, a panel that stopped polling, a panel
 * that never answered, a panel that closed mid-command, and a queue that a dead panel let grow.
 */

/** One panel's report, as a test binds it. */
function bind(clientId: string, sessionId = 's-1'): PreviewBindRequest {
  return {
    clientId,
    sessionId,
    mode: 'url',
    url: 'http://127.0.0.1:3080/advanced-sidebar/preview-proxy?url=http%3A%2F%2F127.0.0.1%3A5173%2F',
    inspectable: true,
    width: 1_024,
    height: 768,
  }
}

/** One DOM reading, the shape a `dom` command must answer with. */
const DOM_RESULT = {
  kind: 'dom' as const,
  selector: 'main',
  viewport: { width: 1_024, height: 768 },
  nodes: [],
  text: 'hello',
  truncated: false,
  url: 'http://127.0.0.1:3080/advanced-sidebar/preview-file?path=%2Fw%2Fa.html',
}

/** A queue with a test clock, so a timeout can be moved to rather than waited out. */
function harness(timeoutMs = 15_000, ttlMs = 6_000): { queue: PreviewBindings; at: (ms: number) => void } {
  let now = 1_000
  const queue = new PreviewBindings(() => ({ commandTimeoutMs: timeoutMs, bindTtlMs: ttlMs, now: () => now }))
  return { queue, at: (ms: number) => { now = ms } }
}

/** Read the command one poll returned, failing loudly when there is none. */
function single(message: { commands: readonly PreviewCommand[] }): PreviewCommand {
  expect(message.commands).toHaveLength(1)
  const command = message.commands[0]
  if (command === undefined) throw new Error('no command')
  return command
}

afterEach(() => { vi.useRealTimers() })

describe('the agent command queue', () => {
  it('refuses immediately when no panel has reported in', async () => {
    const { queue } = harness()
    const outcome = await queue.queue('s-1', { kind: 'dom' })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.code).toBe('no-surface')
    expect(outcome.ok ? '' : outcome.message).toContain('no Preview panel is open')
  })

  it('refuses when the only panel belongs to another session', async () => {
    const { queue } = harness()
    queue.bind(bind('c-1', 's-1'))
    const outcome = await queue.queue('s-2', { kind: 'dom' })
    expect(outcome.ok ? '' : outcome.code).toBe('no-surface')
  })

  it('delivers a queued command to the next poll and resolves with its result', async () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    const pending = queue.queue('s-1', { kind: 'dom', selector: 'main' })
    const command = single(queue.poll('c-1', true).message)
    expect(command.kind).toBe('dom')
    expect(command.selector).toBe('main')
    expect(command.timeoutMs).toBe(15_000)
    expect(command.clientId).toBe('c-1')
    queue.post('c-1', command.id, { ok: true, result: DOM_RESULT })
    await expect(pending).resolves.toEqual({ ok: true, result: DOM_RESULT })
  })

  it('hands a command over once, not on every poll', async () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    const pending = queue.queue('s-1', { kind: 'dom' })
    const command = single(queue.poll('c-1', true).message)
    expect(queue.poll('c-1', true).message.commands).toHaveLength(0)
    queue.post('c-1', command.id, { ok: true, result: DOM_RESULT })
    await expect(pending).resolves.toEqual({ ok: true, result: DOM_RESULT })
  })

  it('fails a delivered command on its own deadline rather than hanging', async () => {
    vi.useFakeTimers()
    const { queue } = harness(500)
    queue.bind(bind('c-1'))
    const pending = queue.queue('s-1', { kind: 'eval', expression: '1+1' })
    queue.poll('c-1', true)
    await vi.advanceTimersByTimeAsync(600)
    const outcome = await pending
    expect(outcome.ok ? '' : outcome.code).toBe('timeout')
    expect(outcome.ok ? '' : outcome.message).toContain('did not answer')
  })

  it('names the undelivered case differently from the unanswered one', async () => {
    vi.useFakeTimers()
    const { queue } = harness(500, 60_000)
    queue.bind(bind('c-1'))
    const pending = queue.queue('s-1', { kind: 'dom' })
    await vi.advanceTimersByTimeAsync(600)
    const outcome = await pending
    expect(outcome.ok ? '' : outcome.message).toContain('was never delivered')
  })

  it('fails work in flight when a panel releases, and drops what it had queued', async () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    const pending = queue.queue('s-1', { kind: 'dom' })
    queue.release('c-1')
    const outcome = await pending
    expect(outcome.ok ? '' : outcome.message).toContain('closed before the command finished')
    expect(queue.active('s-1')).toBeUndefined()
  })

  it('fails an in-flight command when the panel polls with nothing mounted', async () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    const pending = queue.queue('s-1', { kind: 'dom' })
    queue.poll('c-1', false)
    const outcome = await pending
    expect(outcome.ok ? '' : outcome.message).toContain('shows no preview surface')
  })

  it('refuses to grow an unbounded backlog for a panel that stopped polling', async () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    const queued: Promise<unknown>[] = []
    for (let index = 0; index < 32; index += 1) queued.push(queue.queue('s-1', { kind: 'dom' }))
    const refused = await queue.queue('s-1', { kind: 'dom' })
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.message).toContain('not keeping up')
    queue.release('c-1')
    await Promise.all(queued)
  })

  it('stops trusting a panel that has not polled inside the trust window', async () => {
    const { queue, at } = harness(15_000, 5_000)
    queue.bind(bind('c-1'))
    expect(queue.active('s-1')).toBe('c-1')
    // Past the window the panel is not there, and the tool is told so instead of waiting.
    at(1_000 + 5_001)
    expect(queue.active('s-1')).toBeUndefined()
    const outcome = await queue.queue('s-1', { kind: 'dom' })
    expect(outcome.ok ? '' : outcome.code).toBe('no-surface')
  })

  it('lets a tool wake a dock that has not polled yet, once', () => {
    const { queue } = harness()
    // The operator opened the Preview panel and a model asked for a reading in the same second: the
    // first bind is stored without a poll behind it.
    queue.bindAt(bind('c-1'))
    expect(queue.active('s-1')).toBe('c-1')
    // A panel the Host has already forgotten is NOT resurrected by a bind it never sent.
    queue.release('c-1')
    queue.bindAt(bind('c-1'))
    expect(queue.active('s-1')).toBeUndefined()
  })

  it('carries a mode change to the panel', () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    expect(queue.control('c-1', { control: 'open', open: { clientId: 'c-1', mode: 'file', filePath: '/w/a.html' } })).toBe(true)
    const polled = queue.poll('c-1', true)
    expect(polled.message.controls).toHaveLength(1)
    expect(polled.message.controls[0]?.open.filePath).toBe('/w/a.html')
    expect(queue.poll('c-1', true).message.controls).toHaveLength(0)
    expect(queue.control('missing', { control: 'open', open: { clientId: 'missing', mode: 'url' } })).toBe(false)
  })

  it('buffers console entries a poll carried, bounded', () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    const entry = (text: string): PreviewConsoleEntry => ({ level: 'log', text, at: 1 })
    queue.poll('c-1', true, [entry('one'), entry('two')])
    const long = entry('x'.repeat(9_000))
    queue.poll('c-1', true, [long])
    const stored = queue.bindOf('c-1')
    expect(stored).toBeDefined()
    // The line cap is applied at ingest, so nothing oversized ever reaches a model.
    expect(queue.poll('c-1', true).bindTtlMs).toBe(6_000)
  })

  it('drops a result whose command already timed out, without throwing', () => {
    vi.useFakeTimers()
    const { queue } = harness(100)
    queue.bind(bind('c-1'))
    void queue.queue('s-1', { kind: 'dom' })
    const command = queue.poll('c-1', true).message.commands[0]
    vi.advanceTimersByTime(200)
    // The panel answered too late; the Host has already told the tool, and an operator's late
    // report must not be an error.
    expect(queue.post('c-1', command?.id ?? '', { ok: true, result: { kind: 'ack', detail: 'late' } })).toBe(false)
  })

  it('reports a result of the wrong kind rather than handing it to the model', async () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    const pending = queue.queue('s-1', { kind: 'dom' })
    const command = single(queue.poll('c-1', true).message)
    // A panel that answered a DOM reading with a bare acknowledgement would otherwise leave the
    // model reading a sentence where it asked for markup.
    queue.post('c-1', command.id, { ok: true, result: { kind: 'ack', detail: 'done' } })
    const outcome = await pending
    expect(outcome.ok ? '' : outcome.message).toContain('answered a dom command with a ack result')
  })

  it('refuses every command once disposed', async () => {
    const { queue } = harness()
    queue.bind(bind('c-1'))
    queue.dispose()
    const outcome = await queue.queue('s-1', { kind: 'dom' })
    expect(outcome.ok ? '' : outcome.message).toContain('unloading')
  })
})
