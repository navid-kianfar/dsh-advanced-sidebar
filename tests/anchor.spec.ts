import { describe, expect, it } from 'vitest'
import { DEFAULT_PLACEMENT, placeLayer, type Box, type PlacementRequest } from '../src/client/ui/anchor.ts'

/**
 * The collision handling behind every floating surface in the kit.
 *
 * This is the defect the kit exists for: the harness's `Menu` primitive clamps a root list into the
 * viewport but pins a submenu at `left: calc(100% + 10px)`, so a menu anchored near the right edge —
 * which the session header's always is — pushed its `Open in` submenu off screen entirely.
 */

/** A viewport to place against; the numbers are a small window, so a flip is easy to state. */
const VIEWPORT: Box = { left: 0, top: 0, right: 1_000, bottom: 800, width: 1_000, height: 800 }

/** Build one rectangle from its corner and size. */
function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, right: left + width, bottom: top + height, width, height }
}

/** The submenu request: to the right of its row, first item level with it. */
const SUBMENU: PlacementRequest = { ...DEFAULT_PLACEMENT, side: 'right', align: 'start', sideOffset: 2, alignOffset: -4 }

describe('placeLayer', () => {
  it('keeps a submenu on the right while there is room for it', () => {
    const placed = placeLayer(box(200, 100, 220, 30), { width: 200, height: 160 }, VIEWPORT, SUBMENU)
    expect(placed.side).toBe('right')
    expect(placed.left).toBe(422)
  })

  it('flips a submenu to the left of its row rather than off the right edge', () => {
    // A menu anchored against the right edge: 200px of list does not fit in the 60px that remain.
    const row = box(700, 100, 240, 30)
    const placed = placeLayer(row, { width: 200, height: 160 }, VIEWPORT, SUBMENU)
    expect(placed.side).toBe('left')
    expect(placed.left).toBe(498)
    expect(placed.left + 200).toBeLessThanOrEqual(VIEWPORT.width)
  })

  it('keeps the requested side when neither side can hold the layer', () => {
    // Nothing fits either way, so the flip would buy nothing; the height cap is what saves it.
    const placed = placeLayer(box(400, 100, 200, 30), { width: 900, height: 160 }, VIEWPORT, SUBMENU)
    expect(placed.side).toBe('right')
  })

  it('flips a dropped list above its trigger near the bottom edge', () => {
    const placed = placeLayer(box(100, 700, 120, 30), { width: 200, height: 300 }, VIEWPORT, DEFAULT_PLACEMENT)
    expect(placed.side).toBe('top')
    expect(placed.top).toBe(700 - 300 - DEFAULT_PLACEMENT.sideOffset)
  })

  it('shifts an end-aligned list back inside the viewport and reports the shift', () => {
    const placed = placeLayer(box(10, 100, 24, 24), { width: 200, height: 120 }, VIEWPORT, { ...DEFAULT_PLACEMENT, align: 'end' })
    expect(placed.left).toBe(DEFAULT_PLACEMENT.padding)
    expect(placed.align).toBe('start')
  })

  it('caps the height at the room the chosen side actually has', () => {
    const placed = placeLayer(box(100, 600, 120, 30), { width: 200, height: 100 }, VIEWPORT, DEFAULT_PLACEMENT)
    expect(placed.side).toBe('bottom')
    // 800 viewport - 630 anchor bottom - 6 gap, with the 8px clearance added back by the cap.
    expect(placed.maxHeight).toBe(164)
  })

  it('never places a layer above the viewport, however tall it is', () => {
    const placed = placeLayer(box(100, 40, 120, 30), { width: 200, height: 2_000 }, VIEWPORT, DEFAULT_PLACEMENT)
    expect(placed.top).toBeGreaterThanOrEqual(DEFAULT_PLACEMENT.padding)
  })
})
