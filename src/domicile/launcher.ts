/**
 * The app launcher: installed desktop entries as a palette page ("Launch
 * app…", Super+Space). A launched app's window opens beside the focused pane,
 * as every new window does (see `desktop.ts`).
 */
import type { Domicile } from '@domicile-desktop/sdk/shell'
import { dataDirs } from '@domicile-desktop/system-apps/data-dirs'
import type { DesktopEntry } from '@domicile-desktop/system-apps/desktop-entry'
import { installedApps } from '@domicile-desktop/system-apps/installed'
import { PAGES, registerRootItems } from '../commands/commands'
import { useStore } from '../model/store'
import { withX11 } from './x11'
import { isNested } from './nested'

export const TERMINAL = ['alacritty']

let entries: readonly DesktopEntry[] = []
let loading: Promise<void> | undefined

/**
 * Reads every installed application. The palette lists what the last read
 * found, so opening the launcher starts a fresh read for the next time
 * (an app installed by `nixos-rebuild` appears on the second open).
 */
function refresh(domicile: Domicile) {
  loading ??= (async () => {
    try {
      const dirs = await dataDirs(domicile)
      const apps = await dirs.andThenAsync((d) => installedApps(domicile, d))
      apps.match({
        Ok: (found) => {
          entries = found.toSorted((a, b) => a.name.localeCompare(b.name))
        },
        Err: (error) => console.warn('[cwm] could not read installed applications:', error.message),
      })
      dbusActivated = await findDbusActivated(domicile, dirs.unwrapOr([]))
      geckoCommands = await findGecko(domicile, entries)
    } catch (e) {
      console.warn('[cwm] could not read installed applications', e)
    } finally {
      loading = undefined
    }
  })()
  return loading
}

/**
 * Desktop entries marked `DBusActivatable=true` (Nautilus, most GNOME apps).
 * Launching one asks the session bus for it, and the bus starts it with the
 * user manager's environment: while nested in GNOME that is GNOME's display,
 * so the window opened there, even with no copy running.
 */
let dbusActivated = new Set<string>()
async function findDbusActivated(domicile: Domicile, dirs: readonly string[]): Promise<Set<string>> {
  const found = await domicile.processes.run([
    'sh',
    '-c',
    'for d in "$@"; do case "$d" in /*) ;; *) d="$HOME/$d";; esac; ' +
      'grep -l -s "^DBusActivatable=true" "$d"/applications/*.desktop; done; true',
    'sh',
    ...dirs,
  ])
  return found.match({
    Ok: (ran) => new Set(ran.stdout.split('\n').filter(Boolean).map((path) => path.slice(path.lastIndexOf('/') + 1))),
    Err: () => new Set<string>(),
  })
}

/**
 * How a launcher entry starts. Nested in another desktop, a D-Bus activated
 * app gets a private session bus of its own (`dbus-run-session`), so it starts
 * its own copy on this desktop instead of being started, or found, on the
 * host's. That copy shares no bus with the host's apps, so host-only services
 * such as its notifications don't reach it.
 */
function commandFor(e: DesktopEntry): string[] {
  const argv = withX11(e.command, geckoCommands.has(e.command[0] ?? ''))
  return isNested() !== false && dbusActivated.has(e.id) ? ['dbus-run-session', '--', ...argv] : argv
}

/**
 * Commands of Gecko apps (Zotero, Firefox, Thunderbird, any fork), told by the
 * `libxul.so` their package ships rather than by name: they go to the X11
 * bridge (`withX11`), since drawing natively on Wayland inside Domicile they
 * made GPU memory run away.
 */
let geckoCommands = new Set<string>()
async function findGecko(domicile: Domicile, apps: readonly DesktopEntry[]): Promise<Set<string>> {
  const commands = [...new Set(apps.map((a) => a.command[0]).filter((c): c is string => !!c))]
  const found = await domicile.processes.run([
    'sh',
    '-c',
    'for c in "$@"; do p=$(command -v "$c") || continue; p=$(readlink -f "$p"); ' +
      'case "$p" in */bin/*) r=${p%/bin/*};; *) continue;; esac; ' +
      '[ -n "$(find -L "$r" -maxdepth 4 -name libxul.so -print -quit 2>/dev/null)" ] && printf "%s\\n" "$c"; done; true',
    'sh',
    ...commands,
  ])
  return found.match({
    Ok: (ran) => new Set(ran.stdout.split('\n').filter(Boolean)),
    Err: () => new Set<string>(),
  })
}

export const appEntries = () => entries

export function setupLauncher(domicile: Domicile) {
  void refresh(domicile)
  PAGES.apps = {
    title: 'Launch app',
    items: () => {
      void refresh(domicile)
      return [
        {
          id: 'app-web',
          title: 'Web browser',
          keywords: ['internet', 'page', 'url', 'site'],
          hint: 'a page in a pane',
          run: () => domicile.browser.open('about:blank'),
        },
        ...entries.map((e) => ({
          id: 'app-' + e.id,
          title: e.name,
          keywords: [e.words, e.id],
          hint: e.comment || undefined,
          run: () => domicile.processes.launch(commandFor(e)),
        })),
      ]
    },
  }
  registerRootItems(() => [
    {
      id: 'launch',
      title: 'Launch app…',
      group: 'Desktop',
      keywords: ['open', 'run', 'start', 'application', 'program'],
      shortcut: 'Super+Space',
      page: 'apps',
    },
    {
      id: 'web',
      title: 'Web browser',
      group: 'Desktop',
      keywords: ['internet', 'page', 'url', 'site', 'open', 'new window'],
      // A new page opens in a pane beside the focused one, its address bar focused.
      run: () => domicile.browser.open('about:blank'),
    },
    {
      id: 'terminal',
      title: 'Open terminal',
      group: 'Desktop',
      keywords: ['shell', 'console', TERMINAL[0]],
      shortcut: 'Super+↵',
      run: () => domicile.processes.launch(withX11(TERMINAL)),
    },
  ])
}

export const openLauncher = () => useStore.getState().openPalette('apps')
