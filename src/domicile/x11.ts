/**
 * X11 apps (Steam and its games, older apps) through xwayland-satellite.
 *
 * Domicile has no Xwayland, but xwayland-satellite bridges X11 windows to
 * ordinary Wayland toplevels, which then tile like any window. On a real
 * Domicile login there is no X display, so the shell starts the bridge once
 * on `X_DISPLAY` (a reloaded shell finds it running and leaves it be) and
 * puts `DISPLAY` on everything it launches; a terminal passes it on, so
 * `steam` typed there works too. Nested in another desktop, `DISPLAY` is
 * already set to that desktop's X server and nothing changes.
 *
 * Needs `xwayland-satellite` on PATH (the NixOS module installs it).
 */
import type { Domicile } from '@domicile-desktop/sdk/shell'

export const X_DISPLAY = ':11'

/** The display to add to launched commands, once known; none while nested. */
let display: string | undefined

export async function setupX11(domicile: Domicile) {
  // The page can't see the environment its processes start with; ask one.
  const own = (await domicile.processes.run(['sh', '-c', 'printf %s "$DISPLAY"'])).match({
    Ok: (ran) => ran.stdout || undefined,
    Err: () => undefined,
  })
  if (own !== undefined) return
  // Is the bridge already up (a reloaded shell)? Its Xwayland keeps no lock file
  // and a crash leaves the socket behind, so look for the process. The `[x]`
  // keeps pgrep from matching this check's own command line.
  const running = (
    await domicile.processes.run(['sh', '-c', `pgrep -u "$(id -u)" -f '^[x]wayland-satellite ${X_DISPLAY}$' >/dev/null`])
  ).match({
    Ok: (ran) => ran.code === 0,
    Err: () => false,
  })
  if (!running) domicile.processes.launch(['xwayland-satellite', X_DISPLAY])
  display = X_DISPLAY
}

/**
 * `argv` with the X display the desktop's X11 apps use, if the shell runs one.
 *
 * A Gecko app (`gecko`: Zotero, Firefox, Thunderbird, any fork; the launcher
 * tells them by the `libxul.so` in their package) is sent to X11 outright.
 * Drawing natively on Wayland inside Domicile, Gecko made GPU memory run away
 * at ~600 MB/s within a minute or two (a Domicile bug: the engine keeps the
 * buffers), taking the whole system out of memory; through the X11 bridge it
 * stays flat. `GDK_BACKEND=x11`, since packages such as nixpkgs' Zotero export
 * `MOZ_ENABLE_WAYLAND=1` in their own wrapper. The cost is X11's 1x
 * rendering, scaled up on a HiDPI screen.
 */
export const withX11 = (argv: readonly string[], gecko = false): string[] => {
  if (display === undefined) return [...argv]
  return ['env', `DISPLAY=${display}`, ...(gecko ? ['MOZ_ENABLE_WAYLAND=0', 'GDK_BACKEND=x11'] : []), ...argv]
}
