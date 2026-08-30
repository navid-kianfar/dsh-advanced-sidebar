import { describe, expect, it } from 'vitest'
import { PanelController, terminalKey, type OperationTarget } from '../src/client/controller.ts'

/**
 * The terminal group the Terminal panel renders its tab strip from.
 *
 * The handles live here rather than in the panel because a shell outlives the component: switching
 * to another panel or closing the dock unmounts the view, and the Host keeps the process. What this
 * covers is the bookkeeping that has to survive that — which tab is showing after a close, which
 * handles a vanished session leaves behind, and that a superseded allocation is never published.
 */

/** One target to key a group by. */
const TARGET: OperationTarget = { sessionId: 'ses-1', title: 'Session', directory: '/repo' }

/** A second target in the same session but another directory. */
const ELSEWHERE: OperationTarget = { sessionId: 'ses-1', title: 'Session', directory: '/repo/website' }

describe('terminal groups', () => {
  it('keys a group by session AND directory', () => {
    expect(terminalKey(TARGET)).not.toBe(terminalKey(ELSEWHERE))
  })

  it('adds tabs in order and shows the newest', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    controller.addTerminal(key, 'a')
    controller.addTerminal(key, 'b')
    expect(controller.terminals(key).tabs.map(tab => tab.tabId)).toEqual(['a', 'b'])
    expect(controller.terminals(key).activeId).toBe('b')
  })

  it('records an allocation against the tab that asked for it', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    controller.addTerminal(key, 'a')
    controller.settleTerminal(key, 'a', { terminalId: 't1', shell: '/bin/zsh' })
    expect(controller.terminals(key).tabs[0]).toEqual({ tabId: 'a', terminalId: 't1', shell: '/bin/zsh', error: undefined })
  })

  it('ignores an allocation for a tab that has already been closed', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    controller.addTerminal(key, 'a')
    controller.removeTerminal(key, 'a')
    controller.settleTerminal(key, 'a', { terminalId: 't1', shell: '/bin/zsh' })
    expect(controller.terminals(key).tabs).toEqual([])
  })

  it('records a failed allocation as the tab\'s error', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    controller.addTerminal(key, 'a')
    controller.settleTerminal(key, 'a', { error: 'no subprocess capability is mounted' })
    expect(controller.terminals(key).tabs[0]?.error).toBe('no subprocess capability is mounted')
    expect(controller.terminals(key).tabs[0]?.terminalId).toBeUndefined()
  })

  it('returns the handle a closed tab held, so the caller can close the shell', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    controller.addTerminal(key, 'a')
    controller.settleTerminal(key, 'a', { terminalId: 't1', shell: '/bin/zsh' })
    expect(controller.removeTerminal(key, 'a')).toBe('t1')
    expect(controller.removeTerminal(key, 'a')).toBeUndefined()
  })

  it('shows the neighbour to the left when the showing tab is closed', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    for (const id of ['a', 'b', 'c']) controller.addTerminal(key, id)
    controller.activateTerminal(key, 'b')
    controller.removeTerminal(key, 'b')
    expect(controller.terminals(key).activeId).toBe('a')
  })

  it('leaves the showing tab alone when another one is closed', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    for (const id of ['a', 'b']) controller.addTerminal(key, id)
    controller.removeTerminal(key, 'a')
    expect(controller.terminals(key).activeId).toBe('b')
  })

  it('drops the whole group once its last tab is closed', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    controller.addTerminal(key, 'a')
    controller.removeTerminal(key, 'a')
    expect(controller.terminals(key)).toEqual({ tabs: [], activeId: undefined })
  })

  it('hands back every handle a vanished session owned, in every directory', () => {
    const controller = new PanelController()
    const here = terminalKey(TARGET)
    const there = terminalKey(ELSEWHERE)
    const other = terminalKey({ sessionId: 'ses-2', title: 'Other', directory: '/repo' })
    controller.addTerminal(here, 'a')
    controller.settleTerminal(here, 'a', { terminalId: 't1', shell: 'sh' })
    controller.addTerminal(there, 'b')
    controller.settleTerminal(there, 'b', { terminalId: 't2', shell: 'sh' })
    controller.addTerminal(other, 'c')
    controller.settleTerminal(other, 'c', { terminalId: 't3', shell: 'sh' })

    expect([...controller.dropTerminals('ses-1')].sort()).toEqual(['t1', 't2'])
    expect(controller.terminals(here).tabs).toEqual([])
    expect(controller.terminals(other).tabs).toHaveLength(1)
    expect(controller.allTerminals()).toEqual(['t3'])
  })

  it('never reports a handle for a tab whose allocation has not answered', () => {
    const controller = new PanelController()
    const key = terminalKey(TARGET)
    controller.addTerminal(key, 'a')
    expect(controller.allTerminals()).toEqual([])
    expect(controller.dropTerminals('ses-1')).toEqual([])
  })
})

describe('dock width', () => {
  it('stores the width a resize settled on', () => {
    const controller = new PanelController()
    expect(controller.getSnapshot().dockWidth).toBeUndefined()
    controller.setDockWidth(520)
    expect(controller.getSnapshot().dockWidth).toBe(520)
  })

  it('keeps one snapshot identity when the width did not move', () => {
    const controller = new PanelController()
    controller.setDockWidth(520)
    const before = controller.getSnapshot()
    controller.setDockWidth(520)
    expect(controller.getSnapshot()).toBe(before)
  })
})
