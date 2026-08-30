/**
 * The kit's dropdown menu, with submenus that stay on screen.
 *
 * The harness's `Menu` primitive pins a submenu at `left: calc(100% + 10px)` with no collision
 * handling, so a menu anchored near the right edge of the window — the session header's, always —
 * pushed its `Open in` submenu off the viewport entirely. Every surface here is placed through
 * {@link placeLayer}, which flips a submenu to the left of its row when the right side cannot hold
 * it and shifts it vertically to stay inside the window.
 *
 * Keyboard handling follows the WAI-ARIA menu pattern: arrows move, Home/End jump, Right opens a
 * submenu, Left closes it, Escape closes the deepest surface, and focus returns to the row that
 * opened it — and to the trigger when the whole menu closes.
 * @module @achasoft/dsh-advanced-sidebar/client/ui/DropdownMenu
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { IconCheckOutline16, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Layer, insideLayerTree } from './Layer.tsx'
import type { Align, Side } from './anchor.ts'
import { cx } from '../cx.ts'
import css from './Ui.module.css'

/** A selectable row. */
export interface MenuItemNode {
  kind: 'item'
  /** Reported to `onSelect`; unique within the whole tree. */
  id: string
  /** The row's text. */
  label: ReactNode
  /** Why the row cannot be used, shown beside the label rather than replacing it. */
  note?: string | undefined
  /** Leading glyph. */
  icon?: ReactNode | undefined
  /** Unusable rows stay visible: an absent row cannot be told from a mistyped configuration. */
  disabled?: boolean | undefined
  /** Destructive rows take the error colour and its hover fill. */
  danger?: boolean | undefined
  /** Draws a trailing check. */
  checked?: boolean | undefined
}

/** A row that opens a nested surface. */
export interface MenuSubNode {
  kind: 'sub'
  /** Identifies the row; never reported to `onSelect`, which fires only for leaves. */
  id: string
  /** The row's text. */
  label: ReactNode
  /** Leading glyph. */
  icon?: ReactNode | undefined
  /** A disabled parent cannot be opened. */
  disabled?: boolean | undefined
  /** The nested rows. */
  items: readonly MenuNode[]
}

/** A hairline between groups. */
export interface MenuSeparatorNode {
  kind: 'separator'
  /** React key. */
  id: string
}

/** A non-interactive heading above a group. */
export interface MenuLabelNode {
  kind: 'label'
  /** React key. */
  id: string
  /** The heading. */
  text: string
}

/** One entry of a menu surface. */
export type MenuNode = MenuItemNode | MenuSubNode | MenuSeparatorNode | MenuLabelNode

/** Everything the menu renders from. */
export interface DropdownMenuProps {
  /** Whether the menu is showing; the caller owns it, because the trigger does the toggling. */
  open: boolean
  /** Asked to close, from a selection, Escape, or a pointer outside the tree. */
  onClose: () => void
  /** The trigger the root surface is placed against, and focus returns to. */
  anchorRef: RefObject<HTMLElement | null>
  /** The rows. */
  items: readonly MenuNode[]
  /**
   * A leaf was chosen.
   * @param id - the leaf's id.
   */
  onSelect: (id: string) => void
  /** Preferred edge of the trigger; flipped when the surface does not fit there. */
  side?: Side | undefined
  /** Preferred alignment along that edge. */
  align?: Align | undefined
  /** Accessible name of the root surface. */
  label?: string | undefined
}

/** Rows a keyboard can land on. */
const FOCUSABLE = '[role="menuitem"]:not([disabled])'

/**
 * Move focus within one surface.
 * @param list - the surface element.
 * @param delta - 1 for the next row, -1 for the previous; wraps at both ends.
 * @param absolute - `first` or `last` ignores `delta` and jumps.
 */
function moveFocus(list: HTMLElement | null, delta: number, absolute?: 'first' | 'last'): void {
  if (list === null) return
  const rows = [...list.querySelectorAll<HTMLElement>(FOCUSABLE)]
  if (rows.length === 0) return
  if (absolute !== undefined) {
    rows[absolute === 'first' ? 0 : rows.length - 1]?.focus()
    return
  }
  const at = rows.findIndex(row => row === document.activeElement)
  const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length
  rows[next]?.focus()
}

/** One row's shared parts, so a leaf and a submenu parent are drawn identically. */
function RowBody({ node }: { node: MenuItemNode | MenuSubNode }) {
  const note = node.kind === 'item' ? node.note : undefined
  return (
    <>
      {node.icon !== undefined && <span className={css.itemIcon}>{node.icon}</span>}
      <span className={css.itemBody}>
        <span className={css.itemLabel}>{node.label}</span>
        {note !== undefined && note !== '' && <span className={css.itemNote}>{note}</span>}
      </span>
    </>
  )
}

/** What every surface below the root is handed. */
interface SurfaceProps {
  /** The rows of this surface. */
  nodes: readonly MenuNode[]
  /** What this surface is placed against: the trigger, or the row that opened it. */
  anchorRef: RefObject<HTMLElement | null>
  /** The marker every surface of one menu carries, for the outside-pointer test. */
  treeId: string
  /** Preferred edge. */
  side: Side
  /** Preferred alignment. */
  align: Align
  /** Accessible name. */
  label?: string | undefined
  /** Take initial focus; the root does, a submenu leaves focus on its parent row until Right. */
  autoFocus: boolean
  /**
   * A leaf was chosen anywhere below.
   * @param id - the leaf's id.
   */
  onSelect: (id: string) => void
  /** Close the whole menu. */
  onClose: () => void
  /** Close this surface and return focus to the row that opened it; absent on the root. */
  onCloseSelf?: (() => void) | undefined
}

/**
 * One row that opens a nested surface, plus that surface while it is open.
 *
 * A component of its own so the row's element has a stable ref: the nested surface is positioned
 * against it on every scroll and resize, and an anchor object rebuilt per render would re-run the
 * placement effect indefinitely.
 * @param props.node - the parent row.
 * @param props.expanded - whether this row's surface is open.
 * @param props.onExpand - open this row's surface, or close every sibling's.
 * @param props.surface - the shared surface parameters this row's child inherits.
 * @returns the row and, while expanded, its surface.
 */
function SubmenuRow(props: {
  node: MenuSubNode
  expanded: boolean
  onExpand: (id: string | undefined) => void
  surface: Pick<SurfaceProps, 'treeId' | 'onSelect' | 'onClose'>
}) {
  const { node, expanded, onExpand, surface } = props
  const rowRef = useRef<HTMLButtonElement | null>(null)
  const [focusChild, setFocusChild] = useState(false)

  const open = (withFocus: boolean): void => {
    if (node.disabled === true) return
    setFocusChild(withFocus)
    onExpand(node.id)
  }

  return (
    <>
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        className={cx(css.item, expanded && css.itemActive)}
        disabled={node.disabled === true}
        aria-haspopup="menu"
        aria-expanded={expanded}
        onMouseEnter={() => { open(false) }}
        onClick={() => { open(true) }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          open(true)
        }}
      >
        <RowBody node={node} />
        <span className={css.itemChevron}><IconChevronRightOutline14 /></span>
      </button>
      {expanded && (
        <MenuSurface
          nodes={node.items}
          anchorRef={rowRef}
          treeId={surface.treeId}
          // The right of the row, flipping to its left when the window cannot hold it there.
          side="right"
          align="start"
          autoFocus={focusChild}
          onSelect={surface.onSelect}
          onClose={surface.onClose}
          onCloseSelf={() => {
            onExpand(undefined)
            rowRef.current?.focus()
          }}
        />
      )}
    </>
  )
}

/**
 * One menu surface and, recursively, whichever of its rows has an open submenu.
 * @param props - the rows, the anchor, and the tree-wide callbacks.
 * @returns the surface.
 * @see {@link SurfaceProps}
 */
function MenuSurface(props: SurfaceProps) {
  const { nodes, anchorRef, treeId, side, align, label, autoFocus, onSelect, onClose, onCloseSelf } = props
  const [openSub, setOpenSub] = useState<string | undefined>(undefined)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (autoFocus) listRef.current?.focus()
  }, [autoFocus])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Only the surface the event started in acts. Submenus are React children of their parent
    // surface, so an unguarded parent would also move its own focus for a key pressed in a child.
    const target = event.target
    const own = target === event.currentTarget
      || (target instanceof Node && listRef.current?.contains(target) === true)
    if (!own) return
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); event.stopPropagation(); moveFocus(listRef.current, 1); break
      case 'ArrowUp': event.preventDefault(); event.stopPropagation(); moveFocus(listRef.current, -1); break
      case 'Home': event.preventDefault(); event.stopPropagation(); moveFocus(listRef.current, 0, 'first'); break
      case 'End': event.preventDefault(); event.stopPropagation(); moveFocus(listRef.current, 0, 'last'); break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        if (onCloseSelf === undefined) onClose()
        else onCloseSelf()
        break
      case 'ArrowLeft':
        if (onCloseSelf === undefined) break
        event.preventDefault()
        event.stopPropagation()
        onCloseSelf()
        break
      default:
        break
    }
  }

  const horizontal = side === 'left' || side === 'right'
  return (
    <Layer
      open
      anchorRef={anchorRef}
      treeId={treeId}
      role="menu"
      tabIndex={-1}
      className={css.menu}
      contentRef={listRef}
      placement={{ side, align, sideOffset: horizontal ? 2 : 6, alignOffset: horizontal ? -4 : 0 }}
      onKeyDown={onKeyDown}
      {...label === undefined ? {} : { 'aria-label': label }}
    >
      {nodes.map((node) => {
        switch (node.kind) {
          case 'separator':
            return <hr key={node.id} className={css.separator} />
          case 'label':
            return <div key={node.id} className={css.menuLabel} role="presentation">{node.text}</div>
          case 'sub':
            return (
              <SubmenuRow
                key={node.id}
                node={node}
                expanded={openSub === node.id}
                onExpand={setOpenSub}
                surface={{ treeId, onSelect, onClose }}
              />
            )
          case 'item':
            return (
              <button
                key={node.id}
                type="button"
                role="menuitem"
                className={cx(css.item, node.danger === true && css.itemDanger)}
                disabled={node.disabled === true}
                onMouseEnter={() => { setOpenSub(undefined) }}
                onClick={() => { onSelect(node.id) }}
              >
                <RowBody node={node} />
                {node.checked === true && <span className={css.itemCheck}><IconCheckOutline16 /></span>}
              </button>
            )
        }
      })}
    </Layer>
  )
}

/**
 * A dropdown menu anchored to a caller-owned trigger.
 *
 * The trigger is rendered by the caller rather than by this component: each seat needs its own
 * geometry and its own accessible name, and a wrapper element around a flex-centred icon button is
 * not laid out where the button is — which is what put the harness menu's list against the wrong
 * edge in the collapsed rail.
 * @param props - the open state, the trigger, the rows, and the selection callback.
 * @returns the menu surface, or null while closed.
 * @see {@link DropdownMenuProps}
 */
export function DropdownMenu(props: DropdownMenuProps) {
  const { open, onClose, anchorRef, items, onSelect, side = 'bottom', align = 'start', label } = props
  const treeId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (insideLayerTree(event.target, treeId, anchorRef.current)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open, onClose, treeId, anchorRef])

  // Focus returns to the trigger when the menu closes, wherever the close came from. Without it a
  // keyboard user is dropped at the top of the document by an Escape.
  const anchor = anchorRef.current
  useEffect(() => {
    if (!open) return
    return () => {
      if (anchor !== null && document.activeElement === document.body) anchor.focus()
    }
  }, [open, anchor])

  const select = useCallback((id: string) => {
    onClose()
    onSelect(id)
  }, [onClose, onSelect])

  if (!open) return null
  return (
    <MenuSurface
      nodes={items}
      anchorRef={anchorRef}
      treeId={treeId}
      side={side}
      align={align}
      label={label}
      autoFocus
      onSelect={select}
      onClose={onClose}
    />
  )
}
