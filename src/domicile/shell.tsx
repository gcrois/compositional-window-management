/**
 * Entry point when Domicile loads this app as its desktop shell
 * (`npm run build:shell`, then `domicile ./dist-shell/shell.js`).
 *
 * WM keys use Super instead of ⌥, because a focused native window would take
 * ⌥ for itself: Domicile delivers grabbed chords to the shell whichever window
 * has the keyboard, and each is replayed as the ⌥ key the app already handles.
 */
import type { Domicile } from '@domicile-desktop/sdk/shell'
import { StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import App from '../App'
import { onGlobalKeyDown } from '../commands/keys'
import { registerContentKind } from '../content/registry'
// Domicile serves only the module: the build inlines every stylesheet into it (vite.shell.config.ts).
import '../index.css'
import { AppPane } from './AppPane'
import { APP_KIND, closeApp, connect, focusedApp, isFloating, setFullscreen, useDesktop, type AppData } from './desktop'
import { superDrag } from './moves'
import { detectNested, isNested } from './nested'
import { setupX11, withX11 } from './x11'
import { openLauncher, setupLauncher, TERMINAL } from './launcher'
import { Overlays } from './Overlays'
import { BROWSER_KIND, connectBrowser, type BrowserData } from './browser'
import { BrowserPane } from './BrowserPane'
import { registerRootItems } from '../commands/commands'
import { TOUR_KEY } from '../tour/tour'
import * as ops from '../model/ops'
import { useStore } from '../model/store'

/** keysym → the KeyboardEvent `code`/`key` the app's handler reads. */
const KEYS: Record<string, [code: string, key: string]> = {
  Left: ['ArrowLeft', 'ArrowLeft'],
  Right: ['ArrowRight', 'ArrowRight'],
  Up: ['ArrowUp', 'ArrowUp'],
  Down: ['ArrowDown', 'ArrowDown'],
  Escape: ['Escape', 'Escape'],
  comma: ['Comma', ','],
  period: ['Period', '.'],
  equal: ['Equal', '='],
  minus: ['Minus', '-'],
  bracketleft: ['BracketLeft', '['],
  bracketright: ['BracketRight', ']'],
  slash: ['Slash', '/'],
  ...Object.fromEntries('ctnwm'.split('').map((c) => [c, ['Key' + c.toUpperCase(), c]])),
  ...Object.fromEntries('123456789'.split('').map((d) => [d, ['Digit' + d, d]])),
}
/** Shifted variants the app gives a meaning to. */
const SHIFTED = ['Left', 'Right', 'Up', 'Down', 'm']
/** Super+X replayed as ⌘X (palette, go to, undo/redo). */
const CMD = ['k', 'p', 'z']

function bindKeys(domicile: Domicile) {
  const kb = domicile.keyboard
  const replay = (code: string, key: string, mods: KeyboardEventInit) =>
    onGlobalKeyDown(new KeyboardEvent('keydown', { code, key, ...mods, cancelable: true }))
  const handlers = new Map<string, () => void>()
  for (const [sym, [code, key]] of Object.entries(KEYS)) {
    handlers.set(`Meta+${sym}`, () => replay(code, key, { altKey: true }))
    if (SHIFTED.includes(sym)) handlers.set(`Meta+Shift+${sym}`, () => replay(code, key, { altKey: true, shiftKey: true }))
  }
  for (const k of CMD) handlers.set(`Meta+${k}`, () => replay('Key' + k.toUpperCase(), k, { ctrlKey: true }))
  handlers.set('Meta+Shift+z', () => replay('KeyZ', 'z', { ctrlKey: true, shiftKey: true }))
  // Super+Return is the terminal, as in most tiling WMs; "go into container" moves to Super+Shift+Return.
  handlers.set('Meta+Return', () => domicile.processes.launch(withX11(TERMINAL)))
  handlers.set('Meta+Shift+Return', () => replay('Enter', 'Enter', { altKey: true }))
  handlers.set('Meta+space', openLauncher)
  handlers.set('Meta+d', openLauncher)
  handlers.set('Meta+f', toggleFullscreen)
  handlers.set('Meta+l', () => domicile.session.lock())
  handlers.set('Meta+Shift+e', () => logOut(domicile, false))
  // A focused dialog floats outside the layout: Super+W closes it, not the pane behind it.
  handlers.set('Meta+w', () => {
    const focused = domicile.windows.list.find((w) => w.appId === domicile.windows.focused)
    if (focused && isFloating(focused)) return domicile.windows.close(focused.appId)
    replay('KeyW', 'w', { altKey: true })
  })

  for (const chord of handlers.keys()) kb.grab(chord)
  const off = kb.on('shortcut', ({ chord }) => {
    // The replayed handlers act on whatever has focus, which the page's own
    // focus tracking already mirrors; palette/text input needs the keyboard.
    if (domicile.session.locked === true) return
    if (['Meta+k', 'Meta+p', 'Meta+space', 'Meta+d'].includes(chord)) domicile.windows.focusShell()
    handlers.get(chord)?.()
  })
  return () => {
    off()
    for (const chord of handlers.keys()) kb.ungrab(chord)
  }
}

export const Shell = (root: HTMLElement, domicile: Domicile) => {
  registerContentKind({
    id: APP_KIND,
    label: 'Native window',
    icon: '▢',
    create: (): AppData => ({ appId: '', pid: null }),
    Render: AppPane,
    close: ({ appId }: AppData) => closeApp(appId),
  })
  registerContentKind({
    id: BROWSER_KIND,
    label: 'Web page',
    icon: '◍',
    create: (): BrowserData => ({ windowId: '' }),
    Render: BrowserPane,
    // Its page may ask to stay ("Leave site?"); the pane goes once the window does.
    close: ({ windowId }: BrowserData) => domicile.browser.close(windowId),
  })
  // A desktop session isn't a first visit: no tour over the login (⌘K › "Take the tour" still runs it).
  try {
    localStorage.setItem(TOUR_KEY, 'desktop')
  } catch {
    // storage refused: maybeStartTour then treats the tour as seen anyway
  }
  superDrag()
  detectNested(domicile).catch((e: unknown) => console.warn('[cwm] could not tell whether nested:', e))
  setupX11(domicile).catch((e: unknown) => console.warn('[cwm] X11 bridge not started:', e))
  connect(domicile)
  connectBrowser(domicile)
  bindKeys(domicile)
  setupLauncher(domicile)
  registerDesktopCommands(domicile)
  // The palette took the keyboard; closing it hands it back to the focused window.
  useStore.subscribe((s, prev) => {
    const app = focusedApp()
    if (prev.paletteOpen && !s.paletteOpen && app !== undefined) domicile.windows.focus(app)
  })
  // Handles for driving the desktop from DevTools (DOMICILE_ENGINE_ARGS=--remote-debugging-port=…).
  Object.assign(globalThis, { cwm: { domicile, useStore, useDesktop, ops, key: onGlobalKeyDown } })
  // Domicile shows the page once Shell returns, so the first frame must be drawn by then.
  flushSync(() =>
    createRoot(root).render(
      <StrictMode>
        <App />
        <Overlays domicile={domicile} />
      </StrictMode>,
    ),
  )
}

/** Super+F: the focused window over the whole screen, and back. */
function toggleFullscreen() {
  const { fullscreen } = useDesktop.getState()
  setFullscreen(fullscreen !== undefined ? undefined : focusedApp())
}

function registerDesktopCommands(domicile: Domicile) {
  registerRootItems(() => [
    {
      id: 'fullscreen',
      title: useDesktop.getState().fullscreen ? 'Leave full screen' : 'Full screen',
      group: 'Desktop',
      keywords: ['maximize', 'zoom', 'fill'],
      shortcut: 'Super+F',
      run: toggleFullscreen,
    },
    {
      id: 'lock',
      title: 'Lock screen',
      group: 'Desktop',
      keywords: ['away', 'password', 'secure'],
      shortcut: 'Super+L',
      run: () => domicile.session.lock(),
    },
    {
      id: 'log-out',
      title: 'Log out',
      group: 'Desktop',
      keywords: ['quit', 'exit', 'leave', 'session', 'sign out', 'escape'],
      shortcut: 'Super+Shift+E',
      run: () => logOut(domicile),
    },
    {
      id: 'stock-shell',
      title: 'Switch to Domicile’s default shell (manganese)',
      group: 'Desktop',
      keywords: ['escape', 'fallback', 'broken', 'reset', 'manganese'],
      // Windows stay open; `domicile load-shell <path to shell.js>` comes back.
      run: () => domicile.processes.launch(['domicile', 'load-shell', '@domicile-desktop/manganese']),
    },
    {
      id: 'app-titlebars',
      title: document.body.classList.contains('app-headers-shown') ? 'Auto-hide window title bars' : 'Always show window title bars',
      group: 'Desktop',
      keywords: ['header', 'decorations', 'frame', 'chrome'],
      run: () => toggleAppHeaders(),
    },
  ])
  toggleAppHeaders(readPref())
}

// App panes hide CWM's title bar to a thin strip (most apps draw their own);
// hovering the strip shows it. The choice is per machine.
const PREF = 'cwm.appHeaders'
const readPref = () => {
  try {
    return localStorage.getItem(PREF) === 'shown'
  } catch {
    return false
  }
}
function toggleAppHeaders(shown = !document.body.classList.contains('app-headers-shown')) {
  document.body.classList.toggle('app-headers-shown', shown)
  try {
    localStorage.setItem(PREF, shown ? 'shown' : 'auto')
  } catch {
    // per-viewer convenience only
  }
}

/**
 * Ends the login session, back to the login screen. Super+Shift+E asks for a
 * second press within 4 s; the palette item is already a deliberate choice.
 * `loginctl` acts at once (Domicile's own `domicile log-out` asks in a dialog
 * this shell doesn't draw). Apps get SIGTERM, as with any logout. Apps run in
 * their own systemd scopes, so the session id falls back to logind's record
 * of this user's graphical session.
 */
let armed: ReturnType<typeof setTimeout> | undefined
function logOut(domicile: Domicile, confirmed = true) {
  // Nested in GNOME, "the session" is GNOME's: logging out from here would end it.
  if (isNested() !== false) {
    useDesktop.setState({ notice: 'Running in a window inside another desktop: close the window to quit' })
    setTimeout(() => useDesktop.setState({ notice: undefined }), 4000)
    return
  }
  if (!confirmed && armed === undefined) {
    useDesktop.setState({ notice: 'Press Super+Shift+E again to log out' })
    armed = setTimeout(() => {
      armed = undefined
      useDesktop.setState({ notice: undefined })
    }, 4000)
    return
  }
  clearTimeout(armed)
  armed = undefined
  useDesktop.setState({ notice: 'Logging out…' })
  domicile.processes.launch([
    'sh',
    '-c',
    // End the graphical session as Domicile does when it exits on its own: with
    // linger the user manager outlives the login, and a graphical-session.target
    // left active makes the next GNOME login refuse to start.
    'systemctl --user start --job-mode=replace-irreversibly domicile-session-shutdown.target; ' +
      'loginctl terminate-session "${XDG_SESSION_ID:-$(loginctl show-user "$(id -u)" -p Display --value)}"',
  ])
}
