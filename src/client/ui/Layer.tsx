/**
 * The portal every floating surface in the kit is drawn in: menus, submenus, select lists, the date
 * picker, and tooltips.
 *
 * Floating surfaces go to `document.body` rather than staying beside their trigger. The dock, the
 * session header, and the settings card all sit inside overflow-clipping containers, and a list
 * rendered in place is cropped by the first of them.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/Layer
 */

import { createPortal } from 'react-dom'
import type { CSSProperties, MutableRefObject, ReactNode, RefObject } from 'react'
import { useAnchoredLayer, type PlacementRequest } from './anchor.ts'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** Everything a floating surface needs to place itself. */
export interface LayerProps {
  /** Whether the surface is rendered at all. */
  open: boolean
  /** The element the surface is positioned against. */
  anchorRef: RefObject<HTMLElement | null>
  /** Overrides of the default placement request. */
  placement?: Partial<PlacementRequest> | undefined
  /** ARIA role of the surface itself. */
  role?: string | undefined
  /** Marks every surface of one menu tree, so an outside-click test can recognise its own. */
  treeId?: string | undefined
  /** Additional classes on the surface. */
  className?: string | undefined
  /** Additional inline style, merged after the computed position. */
  style?: CSSProperties | undefined
  /** The surface's contents. */
  children: ReactNode
  /** Ref to the surface element, for callers that manage focus inside it. */
  contentRef?: MutableRefObject<HTMLDivElement | null> | undefined
  /** Makes the surface itself focusable, so a menu can take focus without focusing a row. */
  tabIndex?: number | undefined
  /** Accessible name of the surface. */
  'aria-label'?: string | undefined
  /** Called with the surface's own key events, before they reach the document. */
  onKeyDown?: ((event: React.KeyboardEvent<HTMLDivElement>) => void) | undefined
}

/**
 * A positioned floating surface.
 * @param props - the open flag, the anchor, the placement, and the contents.
 * @returns the portal, or null while closed.
 * @see {@link LayerProps}
 */
export function Layer(props: LayerProps) {
  const { open, anchorRef, placement, role, treeId, className, style, children, contentRef, tabIndex, onKeyDown } = props
  const ariaLabel = props['aria-label']
  const layer = useAnchoredLayer(
    open,
    () => anchorRef.current?.getBoundingClientRect() ?? null,
    placement ?? {},
  )

  if (!open) return null
  return createPortal(
    <div
      ref={(node) => {
        layer.ref.current = node
        if (contentRef !== undefined) contentRef.current = node
      }}
      className={cx(css.layer, className)}
      style={{ ...layer.style, ...style }}
      data-side={layer.side}
      {...treeId === undefined ? {} : { 'data-dsh-layer': treeId }}
      {...role === undefined ? {} : { role }}
      {...tabIndex === undefined ? {} : { tabIndex }}
      {...ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }}
      {...onKeyDown === undefined ? {} : { onKeyDown }}
    >
      {children}
    </div>,
    document.body,
  )
}

/**
 * Whether one event target sits inside the trigger or any surface of one layer tree.
 *
 * A portal is outside its trigger's DOM subtree, and a submenu is outside its parent list's, so an
 * outside-click test that only walks the trigger would dismiss the menu on its own rows.
 * @param target - the event target.
 * @param treeId - the tree marker every surface of one menu carries.
 * @param anchor - the trigger element.
 * @returns true when the target belongs to the tree.
 */
export function insideLayerTree(target: EventTarget | null, treeId: string, anchor: Element | null): boolean {
  if (!(target instanceof Node)) return false
  if (anchor?.contains(target) === true) return true
  const element = target instanceof Element ? target : target.parentElement
  if (element === null) return false
  return element.closest(`[data-dsh-layer="${treeId}"]`) !== null
}
