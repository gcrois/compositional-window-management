/**
 * A browser window's pane: a slim address bar over the `<webview>` drawing it
 * (none for an app window, opened with `domicile open --app`), plus what the
 * engine leaves to the shell: browser keys, file pickers (uploads and every
 * download), page dialogs and a page's fullscreen.
 */
import { FilePicker } from '@domicile-desktop/component-library/FilePicker'
import { ChooserMode, type FileRequest } from '@domicile-desktop/component-library/file-request'
import { desktopFolders } from '@domicile-desktop/component-library/folders'
import {
  WEBVIEW_DIALOG_EVENT,
  WEBVIEW_DIALOG_WITHDRAWN_EVENT,
  WEBVIEW_FILE_CHOOSER_EVENT,
  WEBVIEW_FOCUS_REQUEST_EVENT,
  WEBVIEW_GUEST_KEYDOWN_EVENT,
  WEBVIEW_HISTORY_CHANGE_EVENT,
  WEBVIEW_LOADING_CHANGE_EVENT,
  WEBVIEW_PAGE_CHANGE_EVENT,
  WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT,
  WEBVIEW_ZOOM_IN_REQUEST_EVENT,
  WEBVIEW_ZOOM_OUT_REQUEST_EVENT,
} from '@domicile-desktop/sdk/webview-element'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ContentProps } from '../content/registry'
import { useDesktop } from './desktop'
import { addressOf, focusBrowserPane, useBrowser, type BrowserData } from './browser'

declare module 'react' {
  interface WebViewHTMLAttributes<T> extends HTMLAttributes<T> {
    /** The browser window this view draws; read once, when the view connects. */
    window?: string
  }
}

// ------------------------------------------------------------ one view each

/**
 * A browser window shows in one `<webview>` at a time (a second stays empty),
 * so a mirrored browser pane draws the page in its first placement and a note
 * in the others; when that one goes, the next takes over.
 */
const claims = new Map<string, symbol[]>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((fn) => fn())
function useOwnsWindow(windowId: string): boolean {
  const [me] = useState(() => Symbol(windowId))
  useEffect(() => {
    const list = claims.get(windowId) ?? []
    claims.set(windowId, [...list, me])
    changed()
    return () => {
      const rest = (claims.get(windowId) ?? []).filter((s) => s !== me)
      if (rest.length) claims.set(windowId, rest)
      else claims.delete(windowId)
      changed()
    }
  }, [windowId, me])
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    () => claims.get(windowId)?.[0] === me,
  )
}

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const zoomStep = (zoom: number, up: boolean) =>
  up ? (ZOOMS.find((z) => z > zoom + 0.001) ?? 5) : ([...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? 0.25)

// ------------------------------------------------------------ the pane

interface PageState {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  fullscreen: boolean
}

export function BrowserPane({ data }: ContentProps<BrowserData>) {
  const win = useBrowser((s) => s.windows?.find((w) => w.id === data.windowId))
  const listed = useBrowser((s) => s.windows !== null)
  const owns = useOwnsWindow(data.windowId)
  if (!listed) return <div className="app-missing">Browser windows need Domicile (see README).</div>
  if (!win) return <div className="app-missing">Page closed</div>
  if (!owns) return <div className="app-missing">Shown in another place (a page draws in one at a time)</div>
  return <BrowserView windowId={data.windowId} isApp={win.isApp} isPrivate={win.isPrivate} />
}

/** The `<webview>` with its bar, for a window this placement owns. Exported for floating popups. */
export function BrowserView({ windowId, isApp, isPrivate }: { windowId: string; isApp: boolean; isPrivate: boolean }) {
  const domicile = useDesktop((s) => s.domicile)
  const [view, setView] = useState<HTMLWebViewElement | null>(null)
  // The same element, for handlers that act on it (state drives the effects).
  const viewRef = useRef<HTMLWebViewElement | null>(null)
  const attach = useCallback((el: HTMLWebViewElement | null) => {
    viewRef.current = el
    setView(el)
  }, [])
  const address = useRef<HTMLInputElement>(null)
  const [page, setPage] = useState<PageState>({ url: '', canGoBack: false, canGoForward: false, loading: false, fullscreen: false })
  const [typed, setTyped] = useState<string | null>(null)
  const [picking, setPicking] = useState<(FileRequest & { serial: number }) | null>(null)
  const [dialog, setDialog] = useState<DomicileDialogEvent | null>(null)

  // Page state: each event only says to reread; read once on mount too.
  useEffect(() => {
    if (!view) return
    const read = () =>
      setPage({
        url: view.url,
        canGoBack: view.canGoBack,
        canGoForward: view.canGoForward,
        loading: view.loading,
        fullscreen: view.pageFullscreen,
      })
    read()
    const events = [
      WEBVIEW_PAGE_CHANGE_EVENT,
      WEBVIEW_HISTORY_CHANGE_EVENT,
      WEBVIEW_LOADING_CHANGE_EVENT,
      WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT,
    ]
    events.forEach((e) => view.addEventListener(e, read))
    return () => events.forEach((e) => view.removeEventListener(e, read))
  }, [view])

  // A fresh, empty window (the launcher's, Ctrl+T) starts in its address bar.
  useEffect(() => {
    if (view && !isApp && (view.url === '' || view.url === 'about:blank')) address.current?.focus()
  }, [view, isApp])

  const close = useCallback(() => domicile?.browser.close(windowId), [domicile, windowId])

  // Browser keys: the engine has none of Chrome's, and sends each chord the page didn't take.
  useEffect(() => {
    if (!view || !domicile) return
    const keydown = (e: Event) => {
      const k = e as KeyboardEvent
      const ctrl = k.ctrlKey && !k.altKey && !k.metaKey
      const key = k.key.toLowerCase()
      if (ctrl && key === 'l') {
        address.current?.focus()
        address.current?.select()
      } else if (ctrl && key === 'r') view.reload()
      else if (ctrl && key === 'w') close()
      else if (ctrl && key === 't') domicile.browser.open('about:blank')
      else if (ctrl && (key === '=' || key === '+')) view.setZoom(zoomStep(view.zoom, true))
      else if (ctrl && key === '-') view.setZoom(zoomStep(view.zoom, false))
      else if (ctrl && key === '0') view.setZoom(1)
      else if (k.altKey && !k.ctrlKey && key === 'arrowleft') view.goBack()
      else if (k.altKey && !k.ctrlKey && key === 'arrowright') view.goForward()
    }
    const zoomIn = () => view.setZoom(zoomStep(view.zoom, true))
    const zoomOut = () => view.setZoom(zoomStep(view.zoom, false))
    const forward = () => focusBrowserPane(windowId)
    view.addEventListener(WEBVIEW_GUEST_KEYDOWN_EVENT, keydown)
    view.addEventListener(WEBVIEW_ZOOM_IN_REQUEST_EVENT, zoomIn)
    view.addEventListener(WEBVIEW_ZOOM_OUT_REQUEST_EVENT, zoomOut)
    view.addEventListener(WEBVIEW_FOCUS_REQUEST_EVENT, forward)
    return () => {
      view.removeEventListener(WEBVIEW_GUEST_KEYDOWN_EVENT, keydown)
      view.removeEventListener(WEBVIEW_ZOOM_IN_REQUEST_EVENT, zoomIn)
      view.removeEventListener(WEBVIEW_ZOOM_OUT_REQUEST_EVENT, zoomOut)
      view.removeEventListener(WEBVIEW_FOCUS_REQUEST_EVENT, forward)
    }
  }, [view, domicile, windowId, close])

  // File pickers: uploads, and every download (it asks where to save).
  // Unclaimed, the engine cancels them, so nothing could be uploaded or saved.
  useEffect(() => {
    if (!view || !domicile) return
    let serial = 0
    let pending: FileRequest | null = null
    const choosing = (e: Event) => {
      const ev = e as DomicileFileChooserEvent
      const mode = MODES[ev.mode]
      if (mode === undefined) return // a newer engine's mode: let it cancel
      ev.preventDefault()
      pending?.cancel()
      const done = () => {
        pending = null
        setPicking(null)
      }
      const request: FileRequest = {
        mode,
        accept: ev.accept,
        suggestedName: ev.suggestedName,
        home: ev.home,
        currentFolder: ev.currentFolder || undefined,
        folders: desktopFolders(domicile.files),
        choose: (paths) => {
          done()
          ev.choose(paths)
        },
        cancel: () => {
          done()
          ev.cancel()
        },
      }
      pending = request
      setPicking({ ...request, serial: ++serial })
    }
    view.addEventListener(WEBVIEW_FILE_CHOOSER_EVENT, choosing)
    return () => {
      view.removeEventListener(WEBVIEW_FILE_CHOOSER_EVENT, choosing)
      // Don't leave the page waiting on a picker that is gone.
      pending?.cancel()
    }
  }, [view, domicile])

  // alert / confirm / prompt / "Leave site?": unclaimed, they are dismissed.
  useEffect(() => {
    if (!view) return
    const asked = (e: Event) => {
      e.preventDefault()
      setDialog(e as DomicileDialogEvent)
    }
    const withdrawn = () => setDialog(null)
    view.addEventListener(WEBVIEW_DIALOG_EVENT, asked)
    view.addEventListener(WEBVIEW_DIALOG_WITHDRAWN_EVENT, withdrawn)
    return () => {
      view.removeEventListener(WEBVIEW_DIALOG_EVENT, asked)
      view.removeEventListener(WEBVIEW_DIALOG_WITHDRAWN_EVENT, withdrawn)
    }
  }, [view])

  const go = (text: string) => {
    const el = viewRef.current
    if (!el || !text.trim()) return
    el.src = addressOf(text)
    setTyped(null)
    el.focus()
  }

  return (
    <div className={`browser-kind ${page.fullscreen ? 'page-fullscreen' : ''} ${isPrivate ? 'private' : ''}`}>
      {!isApp && !page.fullscreen && (
        <div className="browser-bar">
          <button className="ghost" title="Back (Alt+←)" disabled={!page.canGoBack} onClick={() => view?.goBack()}>
            ←
          </button>
          <button className="ghost" title="Forward (Alt+→)" disabled={!page.canGoForward} onClick={() => view?.goForward()}>
            →
          </button>
          <button
            className="ghost"
            title={page.loading ? 'Stop' : 'Reload (Ctrl+R)'}
            onClick={() => (page.loading ? view?.stop() : view?.reload())}
          >
            {page.loading ? '×' : '↻'}
          </button>
          <input
            ref={address}
            className="browser-address"
            spellCheck={false}
            placeholder="Search or enter address (Ctrl+L)"
            value={typed ?? (page.url === 'about:blank' ? '' : page.url)}
            onChange={(e) => setTyped(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') go(e.currentTarget.value)
              if (e.key === 'Escape') {
                setTyped(null)
                view?.focus()
              }
            }}
          />
          {isPrivate && <span className="badge">private</span>}
        </div>
      )}
      <webview ref={attach} window={windowId} />
      {picking && (
        <div className="page-overlay">
          <FilePicker key={picking.serial} request={picking} />
        </div>
      )}
      {dialog && <PageDialog dialog={dialog} done={() => setDialog(null)} />}
    </div>
  )
}

const MODES: Record<string, ChooserMode> = {
  open: ChooserMode.Open,
  'open-multiple': ChooserMode.OpenMultiple,
  'open-folder': ChooserMode.OpenFolder,
  save: ChooserMode.Save,
}

function PageDialog({ dialog, done }: { dialog: DomicileDialogEvent; done: () => void }) {
  const [value, setValue] = useState(dialog.defaultValue)
  const leaving = dialog.dialogType === 'beforeunload'
  const accept = () => {
    dialog.accept(dialog.dialogType === 'prompt' ? value : undefined)
    done()
  }
  const dismiss = () => {
    dialog.dismiss()
    done()
  }
  return (
    <div className="page-overlay">
      <form
        className="page-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          accept()
        }}
        onKeyDown={(e) => e.key === 'Escape' && dismiss()}
      >
        <div className="muted">{leaving ? 'Leave site?' : (dialog.origin ?? 'This page') + ' says'}</div>
        <div className="page-dialog-message">
          {leaving ? 'Changes you made may not be saved.' : dialog.message}
        </div>
        {dialog.dialogType === 'prompt' && <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />}
        <div className="page-dialog-buttons">
          {dialog.dialogType !== 'alert' && (
            <button type="button" onClick={dismiss}>
              {leaving ? 'Stay' : 'Cancel'}
            </button>
          )}
          <button type="submit" autoFocus={dialog.dialogType !== 'prompt'}>
            {leaving ? 'Leave' : 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}
