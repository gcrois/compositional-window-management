import type { ClientWindow } from '@domicile-desktop/sdk/desktop/windows'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ContentProps } from '../content/registry'
import { isContentChild, isDecoration, useDesktop, type AppData } from './desktop'

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      /** Domicile's engine element: a Wayland window, sized and placed by its layout box. */
      app: { 'app-id': string; style?: CSSProperties; className?: string; ref?: Ref<HTMLElement> }
    }
  }
}

/** Popups of `parent` that are drawn (see {@link isDecoration}). */
const popupsOf = (parent: string, all: readonly ClientWindow[]) =>
  all.filter((w) => w.parent === parent && !isDecoration(w, all))

/** A popup and its own popups, at the offsets the client asked for, in its parent's coordinates. */
function PopupTree({ parent, all }: { parent: string; all: readonly ClientWindow[] }) {
  return popupsOf(parent, all).map((w) => (
    <div key={w.appId} className="app-popup" style={{ left: w.x ?? 0, top: w.y ?? 0 }}>
      <app
        app-id={w.appId}
        style={{
          width: w.width ?? 0,
          height: w.height ?? 0,
          display: 'block',
          // A Gecko content child: drawn, but clicks reach the window beneath (desktop.ts).
          pointerEvents: isContentChild(w, all) ? 'none' : undefined,
        }}
      />
      <PopupTree parent={w.appId} all={all} />
    </div>
  ))
}

/**
 * Menus and tooltips may reach past their window's pane, which clips, so they
 * live in a page-level layer laid over the window's on-screen box (scaled by
 * any canvas zoom) and follow it each frame while open.
 */
export function Popups({ appId, anchor, all }: { appId: string; anchor: RefObject<HTMLElement | null>; all: readonly ClientWindow[] }) {
  const layer = useRef<HTMLDivElement>(null)
  const open = popupsOf(appId, all).length > 0
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const follow = () => {
      const el = anchor.current
      const box = layer.current
      if (el && box) {
        const r = el.getBoundingClientRect()
        // A window in a hidden tab has no box: its popups hide with it rather
        // than float at the corner of whatever is shown.
        box.style.visibility = r.width && r.height ? '' : 'hidden'
        box.style.transform = `translate(${r.x}px, ${r.y}px) scale(${el.offsetWidth ? r.width / el.offsetWidth : 1})`
      }
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [open, anchor])
  if (!open) return null
  return createPortal(
    <div ref={layer} className="app-popups">
      <PopupTree parent={appId} all={all} />
    </div>,
    document.body,
  )
}

/**
 * Every mounted `<app>` per window. A client has one size, and the engine
 * sends a box's size only when that box changes, so when one mirror of a
 * window unmounts the survivors are nudged 1px for a frame to re-send theirs.
 */
const mounted = new Map<string, Set<HTMLElement>>()

function trackMirror(appId: string) {
  return (el: HTMLElement | null) => {
    if (!el) return
    const set = mounted.get(appId) ?? new Set()
    mounted.set(appId, set.add(el))
    return () => {
      set.delete(el)
      for (const other of set) {
        other.style.width = 'calc(100% - 1px)'
        requestAnimationFrame(() => requestAnimationFrame(() => (other.style.width = '')))
      }
    }
  }
}


/**
 * A client won't draw smaller than its minimum size (Firefox: 500px wide), and
 * Domicile shows whatever it draws, so in a smaller pane (a canvas card, a
 * kanban card, a scroll column) the window spilled past its pane. Instead the
 * window is laid out at its minimum and scaled down to fit, like a live
 * thumbnail; Domicile maps the pointer through the transform.
 */
function useFitToMin(
  pane: RefObject<HTMLElement | null>,
  minWidth = 0,
  minHeight = 0,
  /** Changes whenever the pane element may have been replaced. */
  mounted: unknown = undefined,
): CSSProperties | undefined {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = pane.current
    if (!el) return
    // Measured now so the first frame already fits; the observer follows later resizes.
    // oxlint-disable-next-line react/set-state-in-effect -- measuring layout is what a layout effect is for
    setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [pane, mounted])
  if (!size || !size.w || !size.h || (size.w >= minWidth && size.h >= minHeight)) return undefined
  const width = Math.max(size.w, minWidth)
  const height = Math.max(size.h, minHeight)
  const scale = Math.min(size.w / width, size.h / height)
  return { width, height, transform: `scale(${scale})`, transformOrigin: '0 0' }
}

export function AppPane({ data }: ContentProps<AppData>) {
  const windows = useDesktop((s) => s.windows)
  const fullscreen = useDesktop((s) => s.fullscreen === data.appId)
  const anchor = useRef<HTMLElement | null>(null)
  const ref = useMemo(() => {
    const track = trackMirror(data.appId)
    return (el: HTMLElement | null) => {
      anchor.current = el
      return track(el)
    }
  }, [data.appId])
  const open = useDesktop((s) => s.windows?.some((w) => w.appId === data.appId) === true)
  const clientFrame = useDesktop((s) => s.windows?.find((w) => w.appId === data.appId)?.clientFrame === true)
  const minWidth = useDesktop((s) => s.windows?.find((w) => w.appId === data.appId)?.minWidth)
  const minHeight = useDesktop((s) => s.windows?.find((w) => w.appId === data.appId)?.minHeight)
  // The frame (NodeView) is generic; tag it so CSS collapses CWM's header only
  // for windows that draw their own title bar (client-side decorations).
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const frame = body.current?.closest('.frame')
    frame?.classList.toggle('app-csd', clientFrame)
    return () => frame?.classList.remove('app-csd')
  }, [clientFrame, fullscreen, open])
  const fit = useFitToMin(body, minWidth, minHeight, `${open}:${fullscreen}`)
  if (!windows) return <div className="app-missing">Native windows need Domicile (see README).</div>
  if (!windows.some((w) => w.appId === data.appId)) return <div className="app-missing">Window closed</div>
  // Out of the layout (and any canvas zoom) onto the page itself; the pane
  // keeps its place for when it comes back.
  if (fullscreen)
    return (
      <>
        <div className="app-missing" ref={body}>
          Full screen (Super+F)
        </div>
        {createPortal(
          <div className="app-kind app-fullscreen">
            <app app-id={data.appId} ref={ref} />
            <Popups appId={data.appId} anchor={anchor} all={windows} />
          </div>,
          document.body,
        )}
      </>
    )
  return (
    <div className="app-kind" ref={body}>
      <app app-id={data.appId} ref={ref} style={fit} />
      <Popups appId={data.appId} anchor={anchor} all={windows} />
    </div>
  )
}
