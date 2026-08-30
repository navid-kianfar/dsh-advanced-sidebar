/**
 * Collision-aware placement for every layer this package floats above the page: the action menu,
 * its submenus, the select lists, the date picker, and the tooltips.
 *
 * The harness's own `Menu` primitive clamps a root list into the viewport but pins a submenu at
 * `left: calc(100% + 10px)` with no flip, so a menu opened near the right edge pushes its submenu
 * off screen. Placement here is a pure function of four rectangles, which is what makes the flip
 * decision testable and identical for every layer that uses it.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/anchor
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MutableRefObject } from 'react'

/** Which edge of the anchor the layer prefers to sit against. */
export type Side = 'top' | 'right' | 'bottom' | 'left'

/** Where the layer lines up along that edge. */
export type Align = 'start' | 'center' | 'end'

/** A rectangle in viewport coordinates; the browser's `DOMRect` satisfies it. */
export interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

/** How one layer wants to sit against its anchor. */
export interface PlacementRequest {
  /** Preferred edge; flipped to its opposite when the layer does not fit there. */
  readonly side: Side
  /** Preferred alignment along that edge. */
  readonly align: Align
  /** Gap between the anchor edge and the layer, in pixels. */
  readonly sideOffset: number
  /** Shift along the alignment axis before collision handling, in pixels. */
  readonly alignOffset: number
  /** Clearance kept from every viewport edge, in pixels. */
  readonly padding: number
}

/** Where a layer ended up, and how much room it was given. */
export interface Placement {
  /** Viewport x of the layer's left edge. */
  readonly left: number
  /** Viewport y of the layer's top edge. */
  readonly top: number
  /** The edge actually used, after any flip. */
  readonly side: Side
  /** The alignment actually used, after any flip. */
  readonly align: Align
  /** Largest height the layer may occupy at this position; it scrolls internally past it. */
  readonly maxHeight: number
}

/** The default request; every layer overrides only what differs. */
export const DEFAULT_PLACEMENT: PlacementRequest = {
  side: 'bottom',
  align: 'start',
  sideOffset: 6,
  alignOffset: 0,
  padding: 8,
}

/** The opposite of one side, used for both the flip and the fallback. */
const OPPOSITE: Readonly<Record<Side, Side>> = {
  top: 'bottom', bottom: 'top', left: 'right', right: 'left',
}

/**
 * Clamp one coordinate into a range, tolerating a range narrower than the value it bounds.
 * @param value - the coordinate.
 * @param low - the lower bound.
 * @param high - the upper bound; a bound below `low` yields `low`.
 * @returns the clamped coordinate.
 */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high))
}

/**
 * Room between one anchor edge and the matching viewport edge, minus the requested clearance.
 * @param side - the edge to measure from.
 * @param anchor - the anchor rectangle.
 * @param viewport - the viewport rectangle.
 * @param request - the placement request; supplies the gap and the clearance.
 * @returns the available extent along the side's axis.
 */
function room(side: Side, anchor: Box, viewport: Box, request: PlacementRequest): number {
  const gap = request.sideOffset + request.padding
  switch (side) {
    case 'top': return anchor.top - gap
    case 'bottom': return viewport.height - anchor.bottom - gap
    case 'left': return anchor.left - gap
    case 'right': return viewport.width - anchor.right - gap
  }
}

/**
 * Place one layer against its anchor, flipping to the opposite side when it does not fit and
 * shifting along the other axis to stay inside the viewport.
 *
 * The flip is taken only when the opposite side has strictly more room: a layer that fits nowhere
 * keeps the side it asked for and is capped by {@link Placement.maxHeight} instead of jumping to a
 * side that is just as short.
 * @param anchor - the trigger's rectangle, in viewport coordinates.
 * @param layer - the layer's measured size.
 * @param viewport - the viewport rectangle.
 * @param request - the preferred side, alignment, gaps, and clearance.
 * @returns where to position the layer and how tall it may be.
 */
export function placeLayer(
  anchor: Box,
  layer: { readonly width: number; readonly height: number },
  viewport: Box,
  request: PlacementRequest,
): Placement {
  const horizontal = request.side === 'left' || request.side === 'right'
  const extent = horizontal ? layer.width : layer.height
  const primary = room(request.side, anchor, viewport, request)
  const secondary = room(OPPOSITE[request.side], anchor, viewport, request)
  const side = extent > primary && secondary > primary ? OPPOSITE[request.side] : request.side

  let left: number
  let top: number
  if (horizontal) {
    left = side === 'right' ? anchor.right + request.sideOffset : anchor.left - request.sideOffset - layer.width
    top = request.align === 'start'
      ? anchor.top + request.alignOffset
      : request.align === 'end'
        ? anchor.bottom - layer.height - request.alignOffset
        : anchor.top + (anchor.height - layer.height) / 2
  } else {
    top = side === 'bottom' ? anchor.bottom + request.sideOffset : anchor.top - request.sideOffset - layer.height
    left = request.align === 'start'
      ? anchor.left + request.alignOffset
      : request.align === 'end'
        ? anchor.right - layer.width - request.alignOffset
        : anchor.left + (anchor.width - layer.width) / 2
  }

  // The shift is what keeps an end-aligned list attached to a trigger near the opposite edge; the
  // reported align follows it so a caller drawing an arrow points at the right place.
  const maxLeft = viewport.width - layer.width - request.padding
  const maxTop = viewport.height - layer.height - request.padding
  const shiftedLeft = clamp(left, request.padding, Math.max(request.padding, maxLeft))
  const shiftedTop = clamp(top, request.padding, Math.max(request.padding, maxTop))
  const align = horizontal || shiftedLeft === left
    ? request.align
    : shiftedLeft < left ? 'end' : 'start'

  const available = horizontal
    ? viewport.height - 2 * request.padding
    : room(side, anchor, viewport, request) + request.padding
  return {
    left: Math.round(shiftedLeft),
    top: Math.round(shiftedTop),
    side,
    align,
    maxHeight: Math.max(0, Math.round(available)),
  }
}

/** A measured, positioned layer plus the trigger to re-measure it. */
export interface AnchoredLayer {
  /** Attach to the floating element; its box is what placement measures. */
  readonly ref: MutableRefObject<HTMLDivElement | null>
  /** Fixed-position style for the floating element, including its height cap. */
  readonly style: CSSProperties
  /** The edge the layer ended up on, for a directional entry animation. */
  readonly side: Side
  /** Re-measure and reposition now; safe to call from a layout effect. */
  readonly place: () => void
}

/**
 * Whether two placements would draw the layer identically.
 * @param a - the placement in effect, if any.
 * @param b - the freshly computed placement.
 * @returns true when nothing moved.
 */
function same(a: Placement | undefined, b: Placement): boolean {
  return a !== undefined && a.left === b.left && a.top === b.top && a.side === b.side
    && a.align === b.align && a.maxHeight === b.maxHeight
}

/** The style a layer wears before its first measurement: laid out, sized, and invisible. */
const MEASURING: CSSProperties = { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }

/**
 * Position one floating element against a caller-owned anchor rectangle.
 *
 * The first placement runs in a layout effect against the hidden pre-render, so the first painted
 * frame is already final — a layer that measured zero and corrected itself afterwards visibly
 * jumps. While open, scroll (captured, so a scrolling pane counts) and resize re-place it.
 * @param open - whether the layer is rendered; closed suspends every listener.
 * @param getAnchorRect - the anchor's current rectangle; null skips placement for that frame.
 * @param request - overrides of {@link DEFAULT_PLACEMENT}.
 * @returns the ref, the style, the resolved side, and a manual re-place.
 */
export function useAnchoredLayer(
  open: boolean,
  getAnchorRect: () => DOMRect | null,
  request: Partial<PlacementRequest> = {},
): AnchoredLayer {
  const ref = useRef<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<Placement | undefined>(undefined)
  const { side, align, sideOffset, alignOffset, padding } = { ...DEFAULT_PLACEMENT, ...request }

  const place = useCallback(() => {
    const layer = ref.current
    const anchor = getAnchorRect()
    if (layer === null || anchor === null) return
    // The cap is removed before measuring, so a layer that was previously capped short reports the
    // height it actually wants rather than the height it was last squeezed into.
    layer.style.maxHeight = ''
    const next = placeLayer(
      anchor,
      { width: layer.offsetWidth, height: layer.offsetHeight },
      { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight },
      { side, align, sideOffset, alignOffset, padding },
    )
    // Committed only on a real move: a scroll or resize listener that stored an equal-but-new
    // object would re-render every layer at pointer cadence, and an anchor callback rebuilt per
    // render would then never stop re-placing.
    setPlacement(current => same(current, next) ? current : next)
  }, [getAnchorRect, side, align, sideOffset, alignOffset, padding])

  useLayoutEffect(() => {
    if (!open) { setPlacement(undefined); return }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  return {
    ref,
    style: placement === undefined
      ? MEASURING
      : { position: 'fixed', left: placement.left, top: placement.top, maxHeight: placement.maxHeight },
    side: placement?.side ?? side,
    place,
  }
}
