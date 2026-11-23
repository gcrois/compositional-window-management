/**
 * Super+drag moves a window, from anywhere on it, as sway's
 * `floating_modifier` and Domicile's own shell do.
 *
 * Most apps draw their own title bar (Firefox's tab strip, GTK header bars),
 * and released Domicile doesn't hand the shell a client's title-bar drag. But
 * the page hears every press over an `<app>` first, and pointer events carry
 * the modifiers, so a press with Super held is the shell's: its
 * `preventDefault()` keeps it from the client.
 *
 * A tiled window starts CWM's own drag of its pane, the same drag as the
 * frame's grip (or its tab, in a tabs view), so it can go into any container.
 * A floating dialog moves by offset (see `Overlays.tsx`).
 */
import { useDesktop } from './desktop'

/** Starts dragging the pane at `path` (a frame's `data-path`) from a press at (x, y). */
function startPaneDrag(path: string, x: number, y: number): boolean {
  const handle = document.querySelector<HTMLElement>(`[data-drag-handle="${CSS.escape(path)}"]`)
  if (!handle) return false
  // Reveal a collapsed header strip for the drag's duration (styles key off it).
  document.body.classList.add('pointer-dragging')
  const done = () => {
    document.body.classList.remove('pointer-dragging')
    document.removeEventListener('pointerup', done, true)
  }
  document.addEventListener('pointerup', done, true)
  // dnd-kit's pointer sensor starts from a press on the handle and follows the
  // real pointer from there; it activates after 4px, so a still click does nothing.
  handle.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    }),
  )
  return true
}

/** Listens for Super+press on windows. */
export function superDrag(): () => void {
  const down = (e: PointerEvent) => {
    if (!e.isTrusted || e.button !== 0 || !e.metaKey) return
    const target = e.target instanceof Element ? e.target : null
    const app = target?.closest('app')
    const appId = app?.getAttribute('app-id')
    if (!app || !appId) return
    const w = useDesktop.getState().windows?.find((x) => x.appId === appId)
    if (w?.dialog) {
      e.preventDefault()
      moveFloating(appId, { x: e.clientX, y: e.clientY })
      return
    }
    const path = app.closest<HTMLElement>('[data-path]')?.dataset.path
    if (path && startPaneDrag(path, e.clientX, e.clientY)) e.preventDefault()
  }
  document.addEventListener('pointerdown', down, true)
  return () => document.removeEventListener('pointerdown', down, true)
}

// ----------------------------------------------------------- floating windows

type Listener = (appId: string, dx: number, dy: number) => void
const floatListeners = new Set<Listener>()
/** Overlays subscribes to apply drag offsets to its floating dialogs. */
export const onFloatMove = (fn: Listener) => {
  floatListeners.add(fn)
  return () => void floatListeners.delete(fn)
}

/** Follows the pointer until the button comes up, reporting the offset from `from`; NaN at the end. */
export function moveFloating(appId: string, from: { x: number; y: number }) {
  const move = (e: PointerEvent) => floatListeners.forEach((fn) => fn(appId, e.clientX - from.x, e.clientY - from.y))
  const up = () => {
    document.removeEventListener('pointermove', move, true)
    document.removeEventListener('pointerup', up, true)
    floatListeners.forEach((fn) => fn(appId, NaN, NaN))
  }
  document.addEventListener('pointermove', move, true)
  document.addEventListener('pointerup', up, true)
}
