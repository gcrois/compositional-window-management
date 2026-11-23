import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useCallback, useEffect, useRef } from 'react'
import { contentKind } from '../content/registry'
import { indexFromPoint } from '../dnd/dropAdapters'
import type { DropData } from '../dnd/resolveDrop'
import { refCounts, removeSlot, setViewState, slotView } from '../model/ops'
import { act, pathKey, useStore } from '../model/store'
import type { Container, Path, Slot } from '../model/types'
import { Child, FrameControls, MirrorBadge, Title, useDropAdapter, type ViewProps } from './NodeView'
import { displayTitle } from '../model/titles'
import { VIEW_INFO } from './viewInfo'

/**
 * Tabs: the tab *is* the child's header (title, grip, mirror badge), so the
 * active child renders without its own title bar; its controls (view
 * switcher, +, ⋯) sit at the right end of the strip.
 */
export function TabsView({ container, path, depth }: ViewProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const key = pathKey(path)
  const activeId = container.viewState.tabs?.active
  const active = container.slots.find((s) => s.id === activeId) ?? container.slots[0]
  const activeNode = useStore((s) => (active ? s.doc.nodes[active.nodeId] : undefined))

  useDropAdapter(path, (x, y) => ({ index: indexFromPoint(stripRef.current, `[data-slot-in="${key}"]`, x, y, 'x') }))

  return (
    <div className="tabs-view">
      <div className="tab-bar">
        <div className="tab-strip" ref={stripRef} role="tablist">
          {container.slots.map((s) => (
            <Tab key={s.id} container={container} slot={s} path={path} active={s === active} />
          ))}
          <button
            className="ghost tab-add"
            title="New tab"
            onClick={() => {
              useStore.getState().setFocus(path)
              useStore.getState().openPalette('add')
            }}
          >
            +
          </button>
        </div>
        {active && activeNode && (
          <div className="tab-controls">
            <FrameControls node={activeNode} path={[...path, active.id]} view={active.view} />
          </div>
        )}
      </div>
      <div className="tab-panel">
        {/* Inactive tabs stay mounted (hidden): iframes keep their state, and a
            window being dragged out of a tab survives switching tabs mid-drag. */}
        {container.slots.map((s) => (
          <div key={s.id} className="tab-page" hidden={s !== active}>
            <Child container={container} slot={s} path={path} depth={depth} bare />
          </div>
        ))}
        {!active && <div className="empty">No tabs. Press + or ⌘K › Add.</div>}
      </div>
    </div>
  )
}

function Tab({ container, slot, path, active }: { container: Container; slot: Slot; path: Path; active: boolean }) {
  const node = useStore((s) => s.doc.nodes[slot.nodeId])
  const shown = useStore((s) => displayTitle(s.doc, slot.nodeId, { view: slot.view }))
  const refs = useStore((s) => refCounts(s.doc).get(slot.nodeId) ?? 0)
  const childPath = [...path, slot.id]
  const focused = useStore((s) => pathKey(s.focus) === pathKey(childPath))
  const drag = useDraggable({
    id: 'drag:' + pathKey(childPath),
    data: { fromId: container.id, slotId: slot.id, nodeId: slot.nodeId, path: childPath, title: shown },
  })
  // Tabs are drop targets too: the middle of a container tab drops *into*
  // it, the sides reorder. Hovering a tab mid-drag switches to it.
  const drop = useDroppable({
    id: 'droptab:' + pathKey(childPath),
    data: {
      kind: 'tab',
      parentId: container.id,
      parentPath: path,
      nodeId: slot.nodeId,
      childPath,
      isContainer: node?.type === 'container',
      title: shown,
    } satisfies DropData,
  })
  // must be stable: a fresh callback each render would detach/reattach the
  // node and make dnd-kit lose the active element's rect mid-drag
  const { setNodeRef: setDragRef } = drag
  const { setNodeRef: setDropRef } = drop
  const setRefs = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el)
      setDropRef(el)
    },
    [setDragRef, setDropRef],
  )
  useEffect(() => {
    if (!drop.isOver || active || drag.isDragging) return
    const t = setTimeout(() => act((d) => setViewState(d, container.id, 'tabs', { active: slot.id })), 550)
    return () => clearTimeout(t)
  }, [drop.isOver, active, drag.isDragging, container.id, slot.id])
  if (!node) return null
  return (
    <div
      ref={setRefs}
      {...drag.listeners}
      {...drag.attributes}
      // Super+drag on a native window starts this tab's drag (src/domicile/moves.ts).
      data-drag-handle={pathKey(childPath)}
      role="tab"
      aria-selected={active}
      data-slot-in={pathKey(path)}
      className={`tab ${active ? 'active' : ''} ${focused ? 'focused' : ''} ${drag.isDragging ? 'dragging' : ''} ${
        drop.isOver && !drag.isDragging ? 'drop-hover' : ''
      }`}
      title="Click to show · double-click title to rename · drag to move (⌥ to mirror)"
      onClick={() => {
        act((d) => setViewState(d, container.id, 'tabs', { active: slot.id }))
        useStore.getState().setFocus(childPath)
      }}
    >
      <span className="kind-icon">
        {node.type === 'container' ? VIEW_INFO[slotView(useStore.getState().doc, slot)].icon : contentKind(node.content.kind)?.icon}
      </span>
      <Title id={node.id} view={slot.view} />
      <MirrorBadge nodeId={node.id} refs={refs} />
      <button
        className="ghost tab-close"
        title="Close tab"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          act((d) => removeSlot(d, container.id, slot.id))
        }}
      >
        ×
      </button>
    </div>
  )
}
