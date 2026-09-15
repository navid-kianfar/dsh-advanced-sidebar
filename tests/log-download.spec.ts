import { describe, expect, it, vi } from 'vitest'
// The pure slot core, from source: the linked checkout ships no built `lib/index.js`, and this file
// imports nothing at runtime, so it is exactly the registry semantics the renderer delegates to.
import { SlotCore, type SlotComponent } from '@deepseek-ai/dsh-client-ui-slots/src/index.ts'
import {
  asLogDownloadService, isDownloading, LogDownloadBridge, LOG_DOWNLOAD_SEAT_ID,
  LOG_DOWNLOAD_SHADOW_PRIORITY, LOG_DOWNLOAD_SLOT, shadowsHarnessSeat,
  type LogDownloadService, type LogDownloadState,
} from '../src/client/log-download.ts'
import { en, zh } from '../src/client/locales.ts'

/**
 * Download session log, absorbed from the harness's `dsh-session-log-export` into this plugin's menu.
 *
 * Three things have to hold for the header to show one "⋯" without losing the verb: the registry
 * really lets a same-id entry at a lower priority take the harness's cell; the bridge the menu binds
 * mirrors the harness controller and reports itself inactive whenever this plugin is not the
 * download surface; and a controller of the wrong shape is refused rather than called.
 */

/** A stand-in for `SessionLogDownloadController` with a store that can be driven from the test. */
function fakeService(): LogDownloadService & { set: (state: LogDownloadState) => void; listeners: () => number } {
  let state: LogDownloadState = { bySession: {} }
  const listeners = new Set<() => void>()
  return {
    store: {
      getSnapshot: () => state,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    download: vi.fn(async () => {}),
    dismiss: vi.fn(),
    set: (next) => { state = next; for (const listener of [...listeners]) listener() },
    listeners: () => listeners.size,
  }
}

/** An inert component: the registry never renders, it only ranks. */
const Inert: SlotComponent<object> = () => null

/** A core with the header utilities row declared the way ui-conversation declares it. */
function headerRow(): SlotCore {
  const core = new SlotCore()
  core.register({
    name: 'root',
    children: { [LOG_DOWNLOAD_SLOT]: { kind: 'list', scope: 'session' } },
  } as never, Inert as never)
  return core
}

describe('shadowing the harness download button', () => {
  it('takes the harness cell with the same id one priority ahead, whichever registers first', () => {
    for (const order of ['harness-first', 'plugin-first'] as const) {
      const core = headerRow()
      const harness = { name: LOG_DOWNLOAD_SLOT, id: LOG_DOWNLOAD_SEAT_ID }
      const shadow = { name: LOG_DOWNLOAD_SLOT, id: LOG_DOWNLOAD_SEAT_ID, priority: LOG_DOWNLOAD_SHADOW_PRIORITY }
      const menu = { name: LOG_DOWNLOAD_SLOT, id: 'advanced-sidebar', order: 50 }
      const Harness: SlotComponent<object> = () => null
      const Shadow: SlotComponent<object> = () => null
      if (order === 'harness-first') core.register(harness as never, Harness as never)
      core.register(menu as never, Inert as never)
      const disposeShadow = core.register(shadow as never, Shadow as never)
      if (order === 'plugin-first') core.register(harness as never, Harness as never)

      const winners = core.entriesOfSlot(LOG_DOWNLOAD_SLOT)
      expect(winners.map(entry => entry.options.id).sort()).toEqual(['advanced-sidebar', LOG_DOWNLOAD_SEAT_ID])
      expect(winners.find(entry => entry.options.id === LOG_DOWNLOAD_SEAT_ID)?.component).toBe(Shadow)
      expect(shadowsHarnessSeat(core.entries(LOG_DOWNLOAD_SLOT))).toBe(true)

      // Uninstalling the plugin hands the cell straight back.
      disposeShadow()
      expect(core.entriesOfSlot(LOG_DOWNLOAD_SLOT).find(entry => entry.options.id === LOG_DOWNLOAD_SEAT_ID)?.component).toBe(Harness)
    }
  })

  it('reports nothing to shadow when the harness seat is absent or renamed', () => {
    const core = headerRow()
    core.register({ name: LOG_DOWNLOAD_SLOT, id: LOG_DOWNLOAD_SEAT_ID, priority: LOG_DOWNLOAD_SHADOW_PRIORITY } as never, Inert as never)
    expect(shadowsHarnessSeat(core.entries(LOG_DOWNLOAD_SLOT))).toBe(false)
    core.register({ name: LOG_DOWNLOAD_SLOT, id: 'session-log-export-button' } as never, Inert as never)
    expect(shadowsHarnessSeat(core.entries(LOG_DOWNLOAD_SLOT))).toBe(false)
  })
})

describe('the controller service', () => {
  it('accepts the harness controller shape', () => {
    expect(asLogDownloadService(fakeService())).toBeDefined()
  })

  it('refuses an absent or incompatible service rather than calling it', () => {
    expect(asLogDownloadService(undefined)).toBeUndefined()
    expect(asLogDownloadService(null)).toBeUndefined()
    expect(asLogDownloadService({ download: () => {}, dismiss: () => {} })).toBeUndefined()
    expect(asLogDownloadService({ store: { getSnapshot: () => ({}) }, download: () => {}, dismiss: () => {} })).toBeUndefined()
    expect(asLogDownloadService({ ...fakeService(), download: 'nope' })).toBeUndefined()
  })
})

describe('the bridge the menu binds', () => {
  it('is inactive until a controller is attached AND its button is being shadowed', () => {
    const bridge = new LogDownloadBridge()
    const service = fakeService()
    expect(bridge.getSnapshot().active).toBe(false)
    bridge.setShadowing(true)
    expect(bridge.getSnapshot().active).toBe(false)
    const detach = bridge.attach(service)
    expect(bridge.getSnapshot().active).toBe(true)
    bridge.setShadowing(false)
    expect(bridge.getSnapshot().active).toBe(false)
    bridge.setShadowing(true)
    detach()
    expect(bridge.getSnapshot().active).toBe(false)
    expect(service.listeners()).toBe(0)
  })

  it('mirrors the controller state and keeps one snapshot identity between changes', () => {
    const bridge = new LogDownloadBridge()
    const service = fakeService()
    bridge.setShadowing(true)
    bridge.attach(service)
    const listener = vi.fn()
    bridge.subscribe(listener)
    const before = bridge.getSnapshot()
    expect(bridge.getSnapshot()).toBe(before)

    service.set({ bySession: { 'ses-1': { open: true, status: 'downloading', error: null } } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isDownloading(bridge.getSnapshot(), 'ses-1')).toBe(true)
    expect(isDownloading(bridge.getSnapshot(), 'ses-2')).toBe(false)

    service.set({ bySession: { 'ses-1': { open: true, status: 'success', error: null } } })
    expect(isDownloading(bridge.getSnapshot(), 'ses-1')).toBe(false)

    // A redundant shadowing report changes nothing a reader sees, so it notifies no one.
    bridge.setShadowing(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('starts and dismisses through the controller, and reports a click with nothing attached', () => {
    const bridge = new LogDownloadBridge()
    expect(bridge.download('ses-1')).toBe(false)
    const service = fakeService()
    bridge.attach(service)
    expect(bridge.download('ses-1')).toBe(true)
    expect(service.download).toHaveBeenCalledWith('ses-1')
    bridge.dismiss('ses-1')
    expect(service.dismiss).toHaveBeenCalledWith('ses-1')
  })

  it('swallows a rejected export, which the controller already published to its dialog', async () => {
    const bridge = new LogDownloadBridge()
    const service = fakeService()
    service.download = vi.fn(async () => { throw new Error('offline') })
    bridge.attach(service)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      expect(bridge.download('ses-1')).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('ignores a stale detach once another controller replaced the first', () => {
    const bridge = new LogDownloadBridge()
    bridge.setShadowing(true)
    const first = fakeService()
    const second = fakeService()
    const detachFirst = bridge.attach(first)
    bridge.attach(second)
    detachFirst()
    expect(bridge.getSnapshot().active).toBe(true)
    expect(bridge.download('ses-1')).toBe(true)
    expect(second.download).toHaveBeenCalledWith('ses-1')
    expect(first.download).not.toHaveBeenCalled()
  })
})

describe('copy', () => {
  it('words the menu entry and the dialog in both dictionaries', () => {
    const keys = [
      'menu.downloadLog', 'menu.downloadLog.busy', 'menu.downloadLog.unavailable',
      'logs.dialog.preparingTitle', 'logs.dialog.preparingDescription', 'logs.dialog.successTitle',
      'logs.dialog.successDescription', 'logs.dialog.errorTitle', 'logs.dialog.close',
      'logs.dialog.commandFailed',
    ] as const
    for (const key of keys) {
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
    // Worded as the harness's own entry, since it replaces that entry on screen.
    expect(en['menu.downloadLog']).toBe('Download session log')
    expect(zh['menu.downloadLog']).toBe('下载 Session 日志')
  })
})
