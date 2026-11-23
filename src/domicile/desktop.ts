/**
 * Native Wayland windows as leaves, when the app runs as a Domicile shell
 * (Domicile's compositor is a Chromium fork: each client window is an `<app>`
 * element, sized and placed by its layout box).
 *
 * The document stays the source of truth for layout; this module keeps two
 * invariants between it and the compositor's window list:
 *  - every open toplevel has at least one reachable `app` leaf (new windows
 *    open beside the focused window, as ⌥N does);
 *  - no reachable `app` leaf names a closed window.
 * Both are restored after every document change too, so undo, "load layout"
 * or closing a pane can't strand a live window off-screen.
 */
import type { ClientWindow } from '@domicile-desktop/sdk/desktop/windows'
import type { Domicile } from '@domicile-desktop/sdk/shell'
import { WindowRequestKind, WindowState } from '@domicile-desktop/sdk/window-state'
import { produce } from 'immer'
import { create } from 'zustand'
import { addTarget, buildCtx } from '../commands/commands'
import { addChild, makeLeaf, occurrences, reachable, removeSlot, resolvePath, reveal } from '../model/ops'
import { useStore } from '../model/store'
import type { Doc, Leaf, NodeId } from '../model/types'

export const APP_KIND = 'app'

/**
 * Domicile numbers app ids per session (`app-1`, …), so a pane saved from an
 * earlier session would otherwise claim an unrelated new window: the client's
 * pid is part of the identity.
 */
export interface AppData {
  appId: string
  pid: number | null
}

interface DesktopState {
  domicile: Domicile | null
  /** Every listed window, popups included; null until the first list arrives. */
  windows: readonly ClientWindow[] | null
  /**
   * Domicile has delivered its window list. Until then `windows` may be empty
   * although apps are open (as after a shell reload), so no pane is removed.
   */
  listed: boolean
  focused: string | undefined
  /** The window shown over the whole screen, as its client asked or Super+F did. */
  fullscreen: string | undefined
  /** A one-line message over the desktop, such as a logout confirmation. */
  notice: string | undefined
}

export const useDesktop = create<DesktopState>(() => ({
  domicile: null,
  windows: null,
  listed: false,
  focused: undefined,
  fullscreen: undefined,
  notice: undefined,
}))

const appDataOf = (n: Doc['nodes'][NodeId] | undefined): AppData | undefined =>
  n?.type === 'leaf' && n.content.kind === APP_KIND ? (n.content.data as AppData) : undefined
const appIdOf = (n: Doc['nodes'][NodeId] | undefined) => appDataOf(n)?.appId
const identity = ({ appId, pid }: AppData) => `${appId}#${pid ?? ''}`
const windowData = (w: ClientWindow): AppData => ({ appId: w.appId, pid: w.pid ?? null })

const isToplevel = (w: ClientWindow) => w.parent === undefined
/**
 * A "popup" sticking out past its parent on every side is not a menu but a
 * decoration: JetBrains IDEs draw their window's drop shadow as a separate
 * surface, 20px bigger all round. Drawn, it is invisible and covers the IDE,
 * taking its clicks, so it is left out.
 *
 * Strictly bigger: Gecko apps (Zotero, Thunderbird) draw their whole content
 * in a child exactly the size of the window, at its origin, and that must show.
 */
export const isDecoration = (w: ClientWindow, all: readonly ClientWindow[]) => {
  if (w.grab) return false
  const p = all.find((x) => x.appId === w.parent)
  if (!p?.width || !p.height || !w.width || !w.height) return false
  const x = w.x ?? 0
  const y = w.y ?? 0
  return x < 0 && y < 0 && x + w.width > p.width && y + w.height > p.height
}
/**
 * A child exactly the size of its window, at its origin, and not a menu: a
 * Gecko app's (Zotero, Thunderbird) whole content. It is drawn, but the app
 * takes input on the window itself, so clicks pass through it to the window.
 */
export const isContentChild = (w: ClientWindow, all: readonly ClientWindow[]) => {
  if (w.grab || w.parent === undefined) return false
  const p = all.find((x) => x.appId === w.parent)
  return !!p && (w.x ?? 0) === 0 && (w.y ?? 0) === 0 && w.width === p.width && w.height === p.height
}
/**
 * A window 1px or less on a side is a helper the app keeps out of sight
 * (Zotero's LibreOffice integration is 377×1): it gets no pane and no float.
 */
const isHelper = (w: ClientWindow) => (w.width !== undefined && w.width <= 1) || (w.height !== undefined && w.height <= 1)
/**
 * A dialog (a client that gave its window a parent or a fixed size: file
 * choosers, prompts, pinentry) floats over the desktop at the size it drew;
 * see `Overlays.tsx`. Every other window gets a pane.
 *
 * "Fixed size" alone is a weak signal: X11 apps through xwayland-satellite
 * (IntelliJ's main window) can report one, and a whole IDE floated at its own
 * size covers the desktop. So a parentless "dialog" floats only while it is
 * clearly smaller than the screen.
 */
const isDialog = (w: ClientWindow) => {
  if (!w.dialog) return false
  if (w.transientFor !== undefined) return true
  return (w.width ?? 0) <= globalThis.innerWidth * 0.75 && (w.height ?? 0) <= globalThis.innerHeight * 0.75
}
export const isTiled = (w: ClientWindow) => isToplevel(w) && !isHelper(w) && !isDialog(w)
export const isFloating = (w: ClientWindow) => isToplevel(w) && !isHelper(w) && isDialog(w)

/** Doc edits made to follow the compositor skip undo history: undoing one would only be re-synced. */
export const edit = (fn: (d: Doc) => void) => {
  const { doc } = useStore.getState()
  const next = produce(doc, (d) => {
    fn(d)
  })
  if (next !== doc) useStore.setState({ doc: next })
}

// sync's own edits notify the store subscription, which must not re-enter it
// mid-pass: the inner pass would add a window the outer one then adds again.
let syncing = false

function sync() {
  if (syncing) return
  syncing = true
  try {
    syncPass()
  } finally {
    syncing = false
  }
}

function syncPass() {
  const { windows, listed } = useDesktop.getState()
  if (!windows) return
  const open = new Map(
    windows.filter(isTiled).map((w) => [identity(windowData(w)), { title: w.title || w.desktopId || 'Window', data: windowData(w) }]),
  )
  reconcile(APP_KIND, open, identity, listed)
}

/**
 * Keeps one reachable leaf of `kind` per entry of `open` (keyed as `keyOf`
 * keys a leaf's data): retitles the ones shown, removes the ones whose entry
 * has gone (only once `listed`, since a reloaded shell first sees an empty
 * list), and adds a pane beside the focused one for each new entry, as ⌥N
 * does. Native windows and browser windows (`browser.ts`) both sync this way.
 */
export function reconcile<D>(
  kind: string,
  open: ReadonlyMap<string, { title: string; data: D }>,
  keyOf: (data: D) => string,
  listed: boolean,
) {
  const { doc } = useStore.getState()
  const live = reachable(doc)

  const shown = new Set<string>()
  const stale: Leaf[] = []
  const retitle: [NodeId, string][] = []
  for (const id of live) {
    const n = doc.nodes[id]
    if (n?.type !== 'leaf' || n.content.kind !== kind) continue
    const key = keyOf(n.content.data as D)
    const entry = open.get(key)
    if (!entry) {
      if (listed) stale.push(n)
    } else {
      shown.add(key)
      if (n.title !== entry.title) retitle.push([id, entry.title])
    }
  }

  if (stale.length || retitle.length)
    edit((d) => {
      for (const leaf of stale)
        for (const path of occurrences(d, leaf.id)) {
          const { nodes } = resolvePath(d, path)
          removeSlot(d, nodes[nodes.length - 2].id, path[path.length - 1])
        }
      for (const [id, title] of retitle) d.nodes[id].title = title
    })

  for (const [key, entry] of open) {
    if (shown.has(key)) continue
    const t = addTarget(buildCtx())
    let sid = ''
    edit((d) => {
      sid = addChild(d, t.container.id, makeLeaf(entry.title, kind, entry.data), {
        meta: t.meta,
        index: t.index,
        parentView: t.view,
      })
      reveal(d, [...t.path, sid])
    })
    if (sid) useStore.getState().setFocus([...t.path, sid])
  }
}

/** Keyboard follows the focused pane: an app pane gets it, anything else gives it back to the page. */
function pushFocus() {
  const { domicile, focused } = useDesktop.getState()
  if (!domicile) return
  const { doc, focus } = useStore.getState()
  const { nodes } = resolvePath(doc, focus)
  const appId = appIdOf(nodes[nodes.length - 1])
  if (appId !== undefined && appId !== focused) domicile.windows.focus(appId)
  else if (appId === undefined && focused !== undefined) domicile.windows.focusShell()
}

/** A click (or the app itself) took the keyboard: focus that window's pane. */
function pullFocus() {
  const { focused } = useDesktop.getState()
  if (focused === undefined) return
  const { doc, focus } = useStore.getState()
  const { nodes } = resolvePath(doc, focus)
  if (appIdOf(nodes[nodes.length - 1]) === focused) return
  const leaf = [...reachable(doc)].find((id) => appIdOf(doc.nodes[id]) === focused)
  const path = leaf && occurrences(doc, leaf, 1)[0]
  if (path) useStore.getState().setFocus(path)
}

/**
 * Every window is tiled on all edges. Without it a client may commit any
 * size it likes (mpv keeps its video's aspect), and the engine draws the
 * whole buffer past its pane.
 */
const TILED = [WindowState.TiledLeft, WindowState.TiledRight, WindowState.TiledTop, WindowState.TiledBottom]

/** Show `appId` over the whole screen, or put it back in its pane (`undefined`). */
export function setFullscreen(appId: string | undefined) {
  const { domicile, fullscreen } = useDesktop.getState()
  if (!domicile || appId === fullscreen) return
  if (fullscreen !== undefined) void domicile.windows.setStates(fullscreen, TILED)
  if (appId !== undefined) void domicile.windows.setStates(appId, [WindowState.Fullscreen])
  useDesktop.setState({ fullscreen: appId })
}

/** The app in the focused pane, if any. */
export function focusedApp(): string | undefined {
  const { doc, focus } = useStore.getState()
  const { nodes } = resolvePath(doc, focus)
  return appIdOf(nodes[nodes.length - 1])
}

/**
 * Grants a client's fullscreen requests (a video, a game, F11) and ignores
 * maximize: a tiled window already fills its pane.
 */
async function followRequests(domicile: Domicile, signal: { stopped: boolean }) {
  const listening = await domicile.windows.requests()
  listening.match({
    Err: async (error) => console.warn('[cwm] window requests unavailable:', error.message),
    Ok: async ({ items, stop }) => {
      if (signal.stopped) return stop()
      const reader = items.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done || signal.stopped) return stop()
        if (value.kind === WindowRequestKind.Fullscreen) setFullscreen(value.appId)
        else if (value.kind === WindowRequestKind.Unfullscreen && useDesktop.getState().fullscreen === value.appId)
          setFullscreen(undefined)
      }
    },
  })
}

/**
 * A client asked for the keyboard (a link opened in a running browser, a
 * dialog): reveal and focus its pane, or give it the keyboard if it floats.
 */
function grantFocus(domicile: Domicile, appId: string) {
  const w = domicile.windows.list.find((x) => x.appId === appId)
  if (!w) return
  if (isFloating(w)) return domicile.windows.focus(appId)
  const { doc } = useStore.getState()
  const leaf = [...reachable(doc)].find((id) => appIdOf(doc.nodes[id]) === appId)
  const path = leaf && occurrences(doc, leaf, 1)[0]
  if (!path) return
  edit((d) => reveal(d, path))
  useStore.getState().setFocus(path)
  domicile.windows.focus(appId)
}

export function connect(domicile: Domicile): () => void {
  const tiled = new Set<string>()
  const stopBounds = reportBounds(domicile)
  const tile = () => {
    for (const w of domicile.windows.list ?? [])
      if (isTiled(w) && !tiled.has(w.appId)) {
        tiled.add(w.appId)
        void domicile.windows.setStates(w.appId, TILED)
      }
  }
  const read = (listed: boolean) => {
    tile()
    const windows = domicile.windows.list ?? null
    const floating = windows?.filter(isFloating).map((w) => w.appId) ?? []
    const before = new Set(useDesktop.getState().windows?.filter(isFloating).map((w) => w.appId))
    useDesktop.setState((s) => ({
      domicile,
      windows,
      focused: domicile.windows.focused,
      listed: s.listed || listed,
      fullscreen: windows?.some((w) => w.appId === s.fullscreen) ? s.fullscreen : undefined,
    }))
    // A new dialog takes the keyboard, as it would on any desktop.
    const opened = floating.filter((id) => !before.has(id))
    if (listed && opened.length) domicile.windows.focus(opened[opened.length - 1])
    // A popup that opens by itself (not a menu the user pulled down) for a
    // window in a hidden tab, such as IntelliJ asking to trust a project:
    // bring that window's pane forward so the question can be seen.
    const seen = prevPopups ?? new Set<string>()
    const popups = windows?.filter((w) => w.parent !== undefined) ?? []
    prevPopups = new Set(popups.map((w) => w.appId))
    if (!listed) return
    for (const p of popups) {
      if (seen.has(p.appId) || p.grab || isDecoration(p, windows ?? [])) continue
      let top = p
      while (top.parent !== undefined) {
        const up = windows?.find((w) => w.appId === top.parent)
        if (!up) break
        top = up
      }
      const el = document.querySelector<HTMLElement>(`app[app-id="${CSS.escape(top.appId)}"]`)
      if (!el || !el.offsetWidth || !el.offsetHeight) grantFocus(domicile, top.appId)
    }
  }
  let prevPopups: Set<string> | undefined
  read(false)
  sync()
  const signal = { stopped: false }
  followRequests(domicile, signal).catch((e: unknown) => console.warn('[cwm] window requests stopped:', e))
  const offs = [
    () => (signal.stopped = true),
    domicile.windows.on('focusrequest', (appId) => grantFocus(domicile, appId)),
    domicile.windows.on('change', () => {
      read(true)
      sync()
    }),
    // A page is sent the window list before its first focus change.
    domicile.windows.on('focuschange', () => {
      read(true)
      sync()
      pullFocus()
    }),
    useStore.subscribe((s, prev) => {
      if (s.doc !== prev.doc) sync()
      if (s.focus !== prev.focus) pushFocus()
    }),
  ]
  offs.push(stopBounds)
  return () => offs.forEach((off) => off())
}

/** Closing an app pane closes the window; the pane goes when the compositor says it's gone. */
export function closeApp(appId: string) {
  useDesktop.getState().domicile?.windows.close(appId)
}

/**
 * Tells the compositor where each window is drawn, as Domicile asks of a
 * shell: the `<app>`'s box in page pixels (the client draws at that monitor's
 * scale), or an empty box for a window the page does not draw (a 1px helper,
 * a pane in a tab not shown, a popup of either). A window left unreported
 * draws unthrottled, and the engine held every buffer it drew: Zotero's hidden
 * helper filled 32 GB of GPU memory in minutes. Reported empty, a client is
 * suspended and gets one frame callback a second until it has a box again.
 */
function reportBounds(domicile: Domicile): () => void {
  const sent = new Map<string, string>()
  const tick = () => {
    const live = new Set<string>()
    for (const w of domicile.windows.list ?? []) {
      live.add(w.appId)
      // The first drawn, visible `<app>` for the window (a mirror shows a crop of the same client).
      let box = { x: 0, y: 0, width: 0, height: 0 }
      for (const el of document.querySelectorAll<HTMLElement>(`app[app-id="${CSS.escape(w.appId)}"]`)) {
        const r = el.getBoundingClientRect()
        if (r.width >= 1 && r.height >= 1 && el.checkVisibility()) {
          box = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
          break
        }
      }
      const key = `${box.x},${box.y},${box.width},${box.height}`
      if (sent.get(w.appId) !== key) {
        sent.set(w.appId, key)
        domicile.windows.setBounds(w.appId, box)
      }
    }
    for (const id of sent.keys()) if (!live.has(id)) sent.delete(id)
  }
  tick()
  const timer = setInterval(tick, 500)
  const off = domicile.windows.on('change', tick)
  return () => {
    clearInterval(timer)
    off()
  }
}
