/**
 * What a desktop draws above the layout: the lock screen, notifications,
 * floating dialogs and the portal dialogs (file pickers, screen sharing).
 * Domicile leaves all of these to the shell; without them a lock has no way
 * out, notifications go nowhere and an app's file picker never opens.
 */
import { PortalDialogs } from '@domicile-desktop/component-library/PortalDialogs'
import { DEFAULT_NOTIFICATION_ACTION, type Notification } from '@domicile-desktop/sdk/notification'
import type { BrowserWindow } from '@domicile-desktop/sdk/desktop/browser'
import type { ClientWindow } from '@domicile-desktop/sdk/desktop/windows'
import type { Domicile } from '@domicile-desktop/sdk/shell'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Popups } from './AppPane'
import { closeApp, isFloating, useDesktop } from './desktop'
import { moveFloating, onFloatMove } from './moves'
import { browserTitle, isFloatingBrowser, useBrowser } from './browser'
import { BrowserView } from './BrowserPane'

/** A desktop attribute, followed through its `change`-style event. */
function useFollow<T>(subscribe: (fn: () => void) => () => void, read: () => T): T {
  return useSyncExternalStore(subscribe, read)
}

// ------------------------------------------------------------------ lock

function LockScreen({ domicile }: { domicile: Domicile }) {
  const { session } = domicile
  const locked = useFollow((fn) => session.on('lockchange', fn), () => session.locked === true)
  // Mounted only while locked, so each lock starts with an empty field.
  return locked ? <LockPrompt domicile={domicile} /> : null
}

function LockPrompt({ domicile }: { domicile: Domicile }) {
  const { session } = domicile
  const [passphrase, setPassphrase] = useState('')
  const [pending, setPending] = useState(false)
  const [refused, setRefused] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Clients get no input while locked; the page must hold the keyboard to type.
    domicile.windows.focusShell()
    input.current?.focus()
    // A `lockchange` that leaves the desk locked while a passphrase is out is a refusal.
    return session.on('lockchange', () => {
      if (session.locked !== true) return
      setPending((was) => {
        if (was) {
          setRefused(true)
          setPassphrase('')
        }
        return false
      })
    })
  }, [domicile, session])

  return (
    <div className="lock-screen">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!passphrase || pending) return
          setPending(true)
          setRefused(false)
          session.unlock(passphrase)
        }}
      >
        <Clock />
        <input
          ref={input}
          type="password"
          autoFocus
          placeholder="Passphrase"
          value={passphrase}
          disabled={pending}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        <div className="lock-note">{pending ? 'Checking…' : refused ? 'That passphrase did not unlock.' : 'Locked'}</div>
      </form>
    </div>
  )
}

const timeNow = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function Clock() {
  const [time, setTime] = useState(timeNow)
  useEffect(() => {
    const t = setInterval(() => setTime(timeNow()), 5000)
    return () => clearInterval(t)
  }, [])
  return <div className="lock-clock">{time}</div>
}

// --------------------------------------------------------- notifications

const DEFAULT_TIMEOUT_MS = 6000

function Toast({ n, domicile }: { n: Notification; domicile: Domicile }) {
  const { notifications } = domicile
  // Hidden once read, not dismissed: dismissing tells the app the user closed it.
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const ms = n.urgency === 'critical' ? 0 : (n.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (ms === 0) return
    const t = setTimeout(() => setShown(false), ms)
    return () => clearTimeout(t)
  }, [n.urgency, n.timeoutMs])
  if (!shown) return null
  return (
    <div
      className={`toast urgency-${n.urgency} ${n.clickable ? 'clickable' : ''}`}
      onClick={() => {
        if (!n.clickable) return
        notifications.invoke(n.id, DEFAULT_NOTIFICATION_ACTION)
        notifications.dismiss([n.id])
      }}
    >
      {n.icon && <img className="toast-icon" src={n.icon} alt="" />}
      <div className="toast-text">
        <div className="toast-app">{n.appName}</div>
        <div className="toast-summary">{n.summary}</div>
        {n.body && <div className="toast-body">{n.body}</div>}
        {n.actions.length > 0 && (
          <div className="toast-actions">
            {n.actions
              .filter((a) => a.key !== DEFAULT_NOTIFICATION_ACTION)
              .map((a) => (
                <button
                  key={a.key}
                  onClick={(e) => {
                    e.stopPropagation()
                    notifications.invoke(n.id, a.key)
                  }}
                >
                  {a.label}
                </button>
              ))}
          </div>
        )}
      </div>
      <button
        className="ghost toast-close"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation()
          notifications.dismiss([n.id])
        }}
      >
        ×
      </button>
    </div>
  )
}

function Notifications({ domicile }: { domicile: Domicile }) {
  const { notifications } = domicile
  const list = useFollow((fn) => notifications.on('change', fn), () => notifications.list)
  if (!list?.length) return null
  return (
    <div className="toasts">
      {list
        .slice(-5)
        .toReversed()
        .map((n) => (
          // A replaced notification keeps its id but gets a new time: shown afresh.
          <Toast key={`${n.id}:${n.time}`} n={n} domicile={domicile} />
        ))}
    </div>
  )
}

// -------------------------------------------------------- floating windows

/**
 * Dialogs float centered over the desktop at the size they drew, above the
 * layout. They get no tiled states, so they keep their own frame and size.
 */
function FloatingDialogs() {
  const windows = useDesktop((s) => s.windows)
  if (!windows) return null
  return windows.filter(isFloating).map((w) => <FloatingDialog key={w.appId} w={w} all={windows} />)
}

/** Where a floating window has been dragged to, from its bar or with Super+drag (`moves.ts`). */
function useFloatOffset(key: string) {
  const [at, setAt] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const dragging = useRef<{ x: number; y: number } | null>(null)
  useEffect(
    () =>
      onFloatMove((id, dx, dy) => {
        if (id !== key) return
        // NaN: the button came up; keep where it was dropped.
        const d = Number.isNaN(dx) ? null : { x: dx, y: dy }
        const ended = dragging.current
        if (!d && ended) setAt((a) => ({ x: a.x + ended.x, y: a.y + ended.y }))
        dragging.current = d
        setDrag(d)
      }),
    [key],
  )
  const style = { translate: `${at.x + (drag?.x ?? 0)}px ${at.y + (drag?.y ?? 0)}px` }
  const grab = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    moveFloating(key, { x: e.clientX, y: e.clientY })
  }
  return { style, grab }
}

/**
 * A dialog floats centered, moved by dragging its bar or with Super+drag.
 * Windows that leave decorations to the window manager (most X11 apps)
 * get the bar's title and close button; one that draws its own frame gets
 * only a thin grab strip.
 */
function FloatingDialog({ w, all }: { w: ClientWindow; all: readonly ClientWindow[] }) {
  const anchor = useRef<HTMLElement | null>(null)
  const { style, grab } = useFloatOffset(w.appId)
  return (
    <div className="app-dialog" style={style}>
      <div className={`app-dialog-bar ${w.clientFrame ? 'thin' : ''}`} onPointerDown={grab}>
        {!w.clientFrame && (
          <>
            <span className="title">{w.title || w.desktopId || 'Dialog'}</span>
            <button className="ghost" title="Close (Super+W)" onClick={() => closeApp(w.appId)}>
              ×
            </button>
          </>
        )}
      </div>
      <app app-id={w.appId} ref={anchor} style={{ width: w.width ?? 0, height: w.height ?? 0, display: 'block' }} />
      <Popups appId={w.appId} anchor={anchor} all={all} />
    </div>
  )
}

/** Browser windows that asked for a size (sign-in popups, a call's small window) float at it. */
function FloatingBrowsers({ domicile }: { domicile: Domicile }) {
  const windows = useBrowser((s) => s.windows)
  if (!windows) return null
  return windows.filter(isFloatingBrowser).map((w) => <FloatingBrowser key={w.id} w={w} domicile={domicile} />)
}

function FloatingBrowser({ w, domicile }: { w: BrowserWindow; domicile: Domicile }) {
  const { style, grab } = useFloatOffset('browser:' + w.id)
  // An axis the page left unset gets a usual popup size.
  const size = { width: w.width || 520, height: w.height || 640 }
  return (
    <div className="app-dialog browser-popup" style={style}>
      <div className="app-dialog-bar" onPointerDown={grab}>
        <span className="title">{browserTitle(w)}</span>
        <button className="ghost" title="Close" onClick={() => domicile.browser.close(w.id)}>
          ×
        </button>
      </div>
      <div style={size}>
        <BrowserView windowId={w.id} isApp isPrivate={w.isPrivate} />
      </div>
    </div>
  )
}

function Notice() {
  const notice = useDesktop((s) => s.notice)
  return notice ? <div className="desktop-notice">{notice}</div> : null
}

export function Overlays({ domicile }: { domicile: Domicile }) {
  return (
    <>
      <FloatingDialogs />
      <FloatingBrowsers domicile={domicile} />
      <Notice />
      <Notifications domicile={domicile} />
      <PortalDialogs
        domicile={domicile}
        holdKeyboard={() => {
          domicile.windows.focusShell()
          return () => {}
        }}
      />
      <LockScreen domicile={domicile} />
    </>
  )
}
