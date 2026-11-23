/**
 * Domicile's own browser windows as leaves.
 *
 * Domicile's engine is a browser: links opened from apps (`BROWSER` and
 * `xdg-open` point at it), `target=_blank` links, `window.open` and the
 * launcher's "Web browser" all open browser windows that the shell must draw,
 * each as a `<webview window=…>`. Like native windows, each gets a pane
 * (`reconcile` in desktop.ts), so a web page can be split, tabbed, mirrored or
 * put on the canvas like anything else. A window that asked for a size (a
 * sign-in popup, a call's small window) floats at that size instead
 * (`Overlays.tsx`).
 *
 * The engine owns the page, so it outlives the shell: after a reload the new
 * shell finds every window, with its history and scroll, and the saved layout
 * puts each back in its pane.
 */
import type { BrowserWindow } from '@domicile-desktop/sdk/desktop/browser'
import type { Domicile } from '@domicile-desktop/sdk/shell'
import { create } from 'zustand'
import { occurrences, reachable, resolvePath, reveal } from '../model/ops'
import { pathKey, useStore } from '../model/store'
import type { Doc, NodeId } from '../model/types'
import { edit, reconcile } from './desktop'

export const BROWSER_KIND = 'browser'

export interface BrowserData {
  windowId: string
}

interface BrowserState {
  /** Every browser window; null until the engine lists them. */
  windows: readonly BrowserWindow[] | null
}

export const useBrowser = create<BrowserState>(() => ({ windows: null }))

/** A window that asked for a size floats at it, as manganese does. */
export const isFloatingBrowser = (w: BrowserWindow) => w.width > 0 || w.height > 0

export const browserTitle = (w: BrowserWindow) => {
  if (w.title) return w.title
  try {
    return new URL(w.url).host || 'New page'
  } catch {
    return 'New page'
  }
}

const windowIdOf = (n: Doc['nodes'][NodeId] | undefined) =>
  n?.type === 'leaf' && n.content.kind === BROWSER_KIND ? (n.content.data as BrowserData).windowId : undefined

let syncing = false
function sync() {
  const { windows } = useBrowser.getState()
  if (!windows || syncing) return
  syncing = true
  try {
    const open = new Map(
      windows
        .filter((w) => !isFloatingBrowser(w))
        .map((w) => [w.id, { title: browserTitle(w), data: { windowId: w.id } satisfies BrowserData }]),
    )
    reconcile(BROWSER_KIND, open, (d: BrowserData) => d.windowId, true)
  } finally {
    syncing = false
  }
}

/** The `<webview>` drawing `windowId`, if one is mounted. */
export const viewOf = (windowId: string) =>
  document.querySelector<HTMLWebViewElement>(`webview[window="${CSS.escape(windowId)}"]`)

/**
 * The compositor knows nothing of browser windows, so the shell moves the
 * keyboard: a focused browser pane takes it from any native window and puts it
 * in its page; leaving one blurs the page, since keys never reach the shell's
 * document (nor anything it forwards them to) while a guest page has focus.
 */
function pushFocus(domicile: Domicile) {
  const { doc, focus } = useStore.getState()
  const { nodes } = resolvePath(doc, focus)
  const windowId = windowIdOf(nodes[nodes.length - 1])
  const active = document.activeElement
  if (windowId === undefined) {
    if (active instanceof HTMLElement && active.tagName === 'WEBVIEW') active.blur()
    return
  }
  domicile.windows.focusShell()
  const view = viewOf(windowId)
  // Keep the caret where it is when the pane already has focus (its address bar).
  const pane = view?.closest('.browser-kind')
  if (view && !pane?.contains(active)) view.focus()
}

/** Focus the pane showing `windowId`, revealing it (a page asked to come forward). */
export function focusBrowserPane(windowId: string) {
  const { doc } = useStore.getState()
  const leaf = [...reachable(doc)].find((id) => windowIdOf(doc.nodes[id]) === windowId)
  const path = leaf && occurrences(doc, leaf, 1)[0]
  if (!path) return
  edit((d) => reveal(d, path))
  useStore.getState().setFocus(path)
}

export function connectBrowser(domicile: Domicile): () => void {
  const read = () => {
    useBrowser.setState({ windows: domicile.browser.windows ?? null })
    sync()
  }
  read()
  // A click into a page focuses its `<webview>` (the guest's clicks never reach
  // the shell's document, but its focus does): make that pane the focused one.
  const focusin = (e: FocusEvent) => {
    const target = e.target
    if (!(target instanceof HTMLElement) || target.tagName !== 'WEBVIEW') return
    const path = target.closest<HTMLElement>('[data-path]')?.dataset.path
    if (path === undefined || pathKey(useStore.getState().focus) === path) return
    useStore.getState().setFocus(path ? path.split('/') : [])
  }
  document.addEventListener('focusin', focusin, true)
  const offs = [
    domicile.browser.on('change', read),
    useStore.subscribe((s, prev) => {
      if (s.doc !== prev.doc) sync()
      if (s.focus !== prev.focus) pushFocus(domicile)
    }),
    () => document.removeEventListener('focusin', focusin, true),
  ]
  return () => offs.forEach((off) => off())
}

/** Typed text as an address: a URL as is, something like a host over https, anything else a search. */
export function addressOf(text: string): string {
  const t = text.trim()
  // A scheme (`https:`, `about:`, `file:`), but not `host:port`.
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^:/\s]+:\d+(\/|$)/.test(t)) return t
  if (!/\s/.test(t) && (/^[^/\s]+\.[^/\s]+/.test(t) || /^localhost(:\d+)?(\/|$)/.test(t) || /^[^/\s]+:\d+(\/|$)/.test(t)))
    return 'https://' + t
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(t)
}
