import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { contentKind } from '../content/registry'
import { dropAdapters, type DropAdapter } from '../dnd/dropAdapters'
import type { DropData } from '../dnd/resolveDrop'
import { refCounts, removeSlot, rename, setLeafData, setViewAt, viewAt, type Edge } from '../model/ops'
import { act, pathKey, useStore } from '../model/store'
import { VIEW_TYPES, type Container, type Leaf, type NodeId, type Path, type Slot, type ViewType } from '../model/types'
import { displayTitle, isAutoTitled } from '../model/titles'
import { VIEW_INFO, splitEdgesIn } from './viewInfo'
import { VIEW_COMPONENTS, VIEW_CONTROLS } from './registry'
import { FrameBoundary } from './FrameBoundary'

export const MAX_DEPTH = 24

export interface ViewProps {
  container: Container
  path: Path
  depth: number
}

interface NodeViewProps {
  nodeId: NodeId
  path: Path
  depth: number
  /** The container this node is rendered in (absent for the root). */
  parentId?: NodeId
  slot?: Slot
  /** Extra controls placed in the header (view-specific, e.g. grid span). */
  headerExtra?: ReactNode
  /** Lets a parent view (canvas) handle dragging the title bar. */
  onHeaderPointerDown?: (e: React.PointerEvent) => void
  className?: string
  style?: CSSProperties
  derived?: boolean
  /** Hide the header entirely (used by inline document blocks). */
  bare?: boolean
}

/** Renders any node (leaf or container) in a uniform window frame. */
export function NodeView(props: NodeViewProps) {
  const node = useStore((s) => s.doc.nodes[props.nodeId])
  if (!node) return <div className="missing">missing node</div>
  if (props.depth > MAX_DEPTH) return <div className="missing">∞ nesting limit</div>
  return (
    <FrameBoundary label={node.title || node.id}>
      <Frame {...props} node={node} />
    </FrameBoundary>
  )
}

function Frame({
  node,
  path,
  depth,
  parentId,
  slot,
  headerExtra,
  onHeaderPointerDown,
  className = '',
  style,
  derived,
  bare,
}: NodeViewProps & { node: Leaf | Container }) {
  const key = pathKey(path)
  const focused = useStore((s) => pathKey(s.focus) === key)
  const flashing = useStore((s) => s.highlight === node.id)
  const refs = useStore((s) => refCounts(s.doc).get(node.id) ?? 0)
  const setFocus = useStore((s) => s.setFocus)

  // Inside a parent that places by pointer (canvas, kanban, timeline…)
  // dropping on a window just places it there; no edge-splitting.
  const parentView = useStore((s) => (parentId ? viewAt(s.doc, path.slice(0, -1)) : undefined))
  const edges = splitEdgesIn(parentView)
  // how *this placement* shows the container (views are per reference)
  const view: ViewType | undefined = node.type === 'container' ? (slot?.view ?? node.defaultView) : undefined
  const leafDrop = useDroppable({
    id: 'dropleaf:' + key,
    disabled: node.type !== 'leaf' || !parentId,
    data: {
      kind: 'leaf',
      parentId: parentId ?? '',
      parentPath: path.slice(0, -1),
      path,
      title: displayTitle(useStore.getState().doc, node.id, { view }),
      edges,
    } satisfies DropData,
  })

  const shownTitle = useStore((s) => displayTitle(s.doc, node.id, { view }))
  const drag = useDraggable({
    // headerless frames (tab pages) are dragged by their tab, which owns 'drag:'+key
    id: (bare ? 'drag-bare:' : 'drag:') + key,
    disabled: !parentId || bare,
    data: { fromId: parentId, slotId: slot?.id, nodeId: node.id, path, title: shownTitle },
  })

  return (
    <section
      className={`frame ${node.type} ${node.type === 'leaf' ? 'kind-' + node.content.kind : ''} ${focused ? 'focused' : ''} ${flashing ? 'flash' : ''} ${
        derived ? 'derived' : ''} ${bare ? 'bare' : ''
      } ${drag.isDragging ? 'dragging' : ''} ${className}`}
      style={style}
      data-node={node.id}
      data-path={key}
      onPointerDownCapture={() => setFocus(path)}
    >
      {!bare && (
        <header
          className="frame-header"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button,input,select,.grip')) return
            onHeaderPointerDown?.(e)
          }}
        >
          {parentId && (
            <span
              className="grip"
              title="Drag to move into any container (hold Alt to mirror)"
              ref={drag.setNodeRef}
              {...drag.listeners}
              {...drag.attributes}
              data-drag-handle={key}
            >
              ⠿
            </span>
          )}
          <span className="kind-icon">
            {view ? VIEW_INFO[view].icon : node.type === 'leaf' ? (contentKind(node.content.kind)?.icon ?? '?') : '?'}
          </span>
          <Title id={node.id} view={view} />
          {derived && (
            <span className="badge derived-badge" title="No stored layout for this view yet: position is derived">
              derived
            </span>
          )}
          <MirrorBadge nodeId={node.id} refs={refs} />
          <span className="spacer" />
          {headerExtra}
          <FrameControls node={node} path={path} view={view} />
          {parentId && slot && (
            <button className="ghost close" title="Close (remove this reference)" onClick={() => act((d) => removeSlot(d, parentId, slot.id))}>
              ×
            </button>
          )}
        </header>
      )}
      <div className="frame-body" ref={node.type === 'leaf' ? leafDrop.setNodeRef : undefined}>
        {node.type === 'leaf' ? (
          <LeafBody leaf={node} />
        ) : (
          <ContainerBody container={node} path={path} depth={depth} edges={edges} view={view ?? node.defaultView} />
        )}
      </div>
    </section>
  )
}

export function MirrorBadge({ nodeId, refs }: { nodeId: NodeId; refs: number }) {
  if (refs < 2) return null
  return (
    <button
      className="badge mirror-badge"
      title="Mirrored: this node appears in several places. Click to flash all occurrences."
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        useStore.getState().setHighlight(nodeId)
        setTimeout(() => useStore.getState().setHighlight(null), 1200)
      }}
    >
      ⧉ {refs}
    </button>
  )
}

/** View switcher, add and commands buttons. Shared by frame headers and tab strips. */
export function FrameControls({ node, path, view }: { node: Leaf | Container; path: Path; view?: ViewType }) {
  const mirrored = useStore((s) => (refCounts(s.doc).get(node.id) ?? 0) > 1)
  const setFocus = useStore.getState().setFocus
  return (
    <>
      {node.type === 'container' && <ViewControls container={node} path={path} view={view ?? node.defaultView} />}
      {node.type === 'container' && <ViewSelect path={path} view={view ?? node.defaultView} mirrored={mirrored} />}
      {node.type === 'container' && (
        <button
          className="ghost"
          title="Add child (⌘K › Add)"
          onClick={() => {
            setFocus(path)
            useStore.getState().openPalette('add')
          }}
        >
          +
        </button>
      )}
      <button
        className="ghost"
        title="Commands (⌘K)"
        onClick={() => {
          setFocus(path)
          useStore.getState().openPalette()
        }}
      >
        ⋯
      </button>
    </>
  )
}

function ViewControls({ container, path, view }: { container: Container; path: Path; view: ViewType }) {
  const C = VIEW_CONTROLS[view]
  return C ? <C container={container} path={path} /> : null
}

/**
 * A node's title. Titleless containers show an automatic title derived from
 * what they display (italic). Renaming to empty returns to automatic.
 */
export function Title({ id, view }: { id: NodeId; view?: ViewType }) {
  const title = useStore((s) => s.doc.nodes[id]?.title ?? '')
  const shown = useStore((s) => displayTitle(s.doc, id, { view }))
  const auto = useStore((s) => isAutoTitled(s.doc, id))
  const isContainer = useStore((s) => s.doc.nodes[id]?.type === 'container')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  if (!editing)
    return (
      <span
        className={`title ${auto ? 'auto' : ''}`}
        title={
          auto
            ? 'Automatic title (from what this shows). Double-click to name it.'
            : 'Double-click to rename' + (isContainer ? ' (clear to use an automatic title)' : '')
        }
        onDoubleClick={() => {
          setDraft(title)
          setEditing(true)
        }}
      >
        {shown}
      </span>
    )
  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    // leaves need a title; containers may go back to automatic with ''
    if (next !== title && (next || isContainer)) act((d) => rename(d, id, next))
  }
  return (
    <input
      className="title-input"
      autoFocus
      placeholder={isContainer ? shown + ' (automatic)' : ''}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

function ViewSelect({ path, view, mirrored }: { path: Path; view: ViewType; mirrored: boolean }) {
  return (
    <select
      className="view-select"
      value={view}
      title={
        'View this container as… (the children and every view’s layout are kept)' +
        (mirrored ? '\nOnly this copy changes: each mirror has its own view.' : '')
      }
      onChange={(e) => act((d) => setViewAt(d, path, e.target.value as ViewType))}
    >
      {VIEW_TYPES.map((v) => (
        <option key={v} value={v}>
          {VIEW_INFO[v].icon} {VIEW_INFO[v].label}
        </option>
      ))}
    </select>
  )
}

export function LeafBody({ leaf }: { leaf: Leaf }) {
  const kind = contentKind(leaf.content.kind)
  if (!kind) return <div className="missing">Unknown content kind “{leaf.content.kind}”</div>
  const R = kind.Render
  return (
    <R data={leaf.content.data} update={(data) => act((d) => setLeafData(d, leaf.id, data), { key: 'edit:' + leaf.id })} />
  )
}

function ContainerBody({
  container,
  path,
  depth,
  edges,
  view,
}: ViewProps & { edges?: Edge[]; view: ViewType }) {
  const key = pathKey(path)
  const drop = useDroppable({
    id: 'drop:' + key,
    data: {
      kind: 'container',
      containerId: container.id,
      path,
      title: displayTitle(useStore.getState().doc, container.id, { view }),
      edges,
    } satisfies DropData,
  })
  const View = VIEW_COMPONENTS[view]
  return (
    <div className={`container-body view-${view}`} ref={drop.setNodeRef}>
      <View container={container} path={path} depth={depth} />
    </div>
  )
}

/** Register how a drop maps into this container's view semantics. */
export function useDropAdapter(path: Path, adapter: DropAdapter) {
  const ref = useRef(adapter)
  ref.current = adapter
  const key = pathKey(path)
  useEffect(() => {
    dropAdapters.set(key, (x, y) => ref.current(x, y))
    return () => {
      dropAdapters.delete(key)
    }
  }, [key])
}

/** Helper for views: render the child behind a slot. */
export function Child({
  container,
  slot,
  path,
  depth,
  ...rest
}: {
  container: Container
  slot: Slot
  path: Path
  depth: number
} & Omit<NodeViewProps, 'nodeId' | 'path' | 'depth' | 'parentId' | 'slot'>) {
  return <NodeView nodeId={slot.nodeId} path={[...path, slot.id]} depth={depth + 1} parentId={container.id} slot={slot} {...rest} />
}

/** Pointer-drag helper: calls onMove with the delta since pointerdown. */
export function startPointerDrag(
  e: React.PointerEvent | PointerEvent,
  onMove: (dx: number, dy: number, ev: PointerEvent) => void,
  onEnd?: () => void,
) {
  e.preventDefault()
  const sx = e.clientX
  const sy = e.clientY
  document.body.classList.add('pointer-dragging')
  const move = (ev: PointerEvent) => onMove(ev.clientX - sx, ev.clientY - sy, ev)
  const up = () => {
    document.body.classList.remove('pointer-dragging')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    onEnd?.()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
