# Compositional WM

A webapp illustrating [On Compositional Window Management](https://bandukwala.me/on-compositional-window-management/).
Try it at <https://bandukwala.me/compositional-window-management/>.
The content is one DAG of nodes. Every container is a *view* of its children, and any container can switch views in place:
tabs, split, canvas, floating, grid, dock, document, outline, JSON, scrolling, master + stack, spiral, table, kanban,
or timeline.

```sh
nix develop     # Node, if it isn't installed (flake.nix)
npm install
npm run dev     # http://localhost:5173
npm test        # model tests (lens round-trips, mirroring, cycles)
```

A guided tour starts on the first visit (`src/tour/tour.ts`, built on driver.js). Replay it with the **?** button
or ⌘K → "Take the tour". Steps that need demo content your layout lacks are skipped.

## As a Wayland desktop (Domicile)

[Domicile](https://www.domicile-desktop.com/) is a Wayland compositor that is a patched Chromium: each native window
is an `<app>` element, sized and placed by its layout box. Loaded as a Domicile shell, this app manages real windows:
each one becomes a leaf (`src/domicile/`), so every view (tabs, canvas, kanban, …) lays it out like any pane.

### Try it

You need Linux with a Wayland session running (the desktop opens as a window inside it), Node.js and npm, and
[Alacritty](https://alacritty.org/) if you want Super+Return to open a terminal.

1. Install Domicile from its [install page](https://www.domicile-desktop.com/docs/install) (packages for Debian,
   Ubuntu, Fedora, openSUSE and Arch). With Nix instead:

   ```sh
   nix build github:cprussin/domicile/release#domicile -o domicile
   export PATH="$PWD/domicile/bin:$PATH"
   ```

   The engine (Domicile's Chromium) is a prebuilt download from its GitHub releases; Nix builds only the
   compositor and the bundled shells, which takes a few minutes. On NixOS, `nixosModules.default` adds a `domicile`
   login session (see `programs.domicile`).

2. Build the shell and start it:

   ```sh
   git clone https://github.com/7h3kk1d/compositional-window-management
   cd compositional-window-management
   npm install
   npm run build:shell
   domicile ./dist-shell/shell.js
   ```

3. A window opens with the desktop in it. Press **Super+Return** for a terminal and launch apps from there; each
   new window gets a pane beside the focused one. Close the Domicile window to quit.

After changing the code, run `npm run build:shell` and then, from a terminal *inside* the desktop,
`domicile load-shell ./dist-shell/shell.js`: the new build loads and open windows stay.

### Keys

The ⌥ keys move to **Super**, since a focused app would take ⌥ itself: Super+arrows moves focus and Super+Shift+arrows moves the window, Super+1…9
switches the view, Super+W closes, Super+K / P / Z are the palette, go-to and undo (⌘K / ⌘P / ⌘Z in the browser).
Super+Return opens a terminal, so "go into container" is Super+Shift+Return.

| Key | Does |
|---|---|
| Super+Space (or Super+D) | Launch app: installed desktop entries, searched in the palette (⌘K › "Launch app…") |
| Super+F | The focused window full screen, and back (apps asking for fullscreen get it too) |
| Super+L | Lock |
| Super+drag | Move the window under the pointer (any app, from anywhere on it), as the frame grip does |
| Super+Shift+E, twice | Log out, back to the login screen (also ⌘K › "Log out") |

### Getting out

- **Super+Shift+E twice**, or ⌘K › "Log out": ends the session; pick GNOME (or another session) at the login screen.
- **Ctrl+Alt+F3**: a text console. Domicile's engine handles this itself, below the shell, so it works even when the
  shell is broken. Log in and run `loginctl terminate-session <id>` (`loginctl list-sessions` shows the id), or
  `domicile load-shell @domicile-desktop/manganese` from a terminal on the desktop to swap in the stock shell.
- **⌘K › "Switch to Domicile’s default shell"**: the same swap, keeping open windows.
- A shell that fails to load is retried five times, then the desktop stops and you are back at the login screen.
- Over SSH (or Tailscale) from another machine: `loginctl terminate-session <id>`.
- If GNOME then bounces back to the login screen ("A graphical session is already running!" in the journal), the
  Domicile session ended without its cleanup (a crash, or `loginctl terminate-session`) and, with linger, left
  `graphical-session.target` up. From a console or SSH: `systemctl --user start --job-mode=replace-irreversibly
  domicile-session-shutdown.target`. Super+Shift+E runs this itself before logging out.

### How it behaves

- Closing an app removes its pane, and Super+W on a window's last pane closes the app.
- An app that draws its own title bar (Firefox, GTK apps) gets CWM's header as a thin strip along its top; hover the
  strip to drag, retitle or close the pane, or Super+drag the window itself. Apps that leave decorations to the window
  manager keep the full header. ⌘K › "Always show window title bars" keeps it open everywhere.
- A pane smaller than its app's minimum size (Firefox won't go under 500px wide) shows the window at its minimum,
  scaled down to fit, instead of letting it spill past the pane.
- Dialogs (file choosers, prompts: windows with a parent or a fixed size) float centered at their own size instead of
  taking a pane. Drag their bar to move them; × or Super+W closes the focused one.
- A pane that fails to render shows its error in place; the rest of the desktop keeps running.
- Menus and tooltips are drawn in a page-level layer over their window, so a pane edge doesn't clip them.
- A mirrored window renders in every placement, but a client has one size: the most recently laid-out placement sets
  it, and the others show a crop.
- The shell draws what Domicile leaves to it (`src/domicile/Overlays.tsx`): the lock screen (Domicile locks before
  sleep, and only the shell can take the passphrase), notifications, and portal dialogs (file pickers, screen-share
  and screenshot pickers) through Domicile's `PortalDialogs`.
- Wayland tools that work: `grim`/`slurp`, `wf-recorder`, `wl-clipboard`, clipboard managers. Domicile has no
  layer-shell, so panels and notification daemons such as waybar or mako don't show.
- X11 apps (Steam and its games) run through `xwayland-satellite`, which the shell starts on `DISPLAY=:11` when the
  session has no X display, adding that `DISPLAY` to everything it launches (`src/domicile/x11.ts`).
- `globalThis.cwm` exposes the store and key handler for driving the desktop over DevTools
  (`DOMICILE_ENGINE_ARGS=--remote-debugging-port=…`).

## Ideas in the code

- **Layout lives on the edge** (`Slot.meta`, `src/model/types.ts`). The same node can be mirrored into several
  parents, each with its own position and size.
- **Views are per placement too** (`Slot.view`). A container mirrored into two places can be a grid in one and an
  outline in the other, both live on the same data (the demo mirrors Projects onto the Play canvas as an outline).
  The root has no slot, so it uses `Container.defaultView`, which is also the starting view for new placements.
  View *state* (active tab, pan/zoom, grid columns) is still shared per container.
- **Lens complement.** Each view's metadata is kept side by side, so switching canvas → tabs → canvas restores the original layout exactly.
  Actions only write the active view's key. A child created in tabs has no canvas position, so the canvas *derives*
  one, shown dashed with a "derived" badge (`src/model/viewMeta.ts`), until you move it or run "Materialize".
- **Each view stores a different amount**, which is the point of having them side by side:
  - *Spiral* (bspwm-style auto-tiling) stores nothing: its layout is a pure function of the order.
  - *Master + stack* (dwm/xmonad) stores only a ratio and a count on the container; "make main" reorders the shared
    order, so it changes every other linear view too.
  - *Scrolling* (PaperWM/niri) stores only a width fraction per column. Each child is one column, in the shared order;
    several windows in a column are just a nested titleless vertical split (⇤ or ⌥[ stacks, ⌥] unstacks), so they
    resize, or turn into tabs, like any other container. New windows open beside the focused column, and “◎ center”
    keeps the focused column in the middle.
  - *Kanban* stores a lane per card, and the lane list on the container. Cards made in other views sit in the first
    lane, marked derived. *Timeline* stores inclusive start/end dates; undated windows are laid end to end after the
    dated ones. (The demo's "Write the post" is mirrored into both, with a lane in one and dates in the other.)
  - *Table* shows the lens complement itself: one column per view's metadata, stored values plain and derived ones
    faded with "~". Click a cell to edit it as JSON; clear it to forget that view's layout for that child.
- **Pure ops** (`src/model/ops.ts`) are used by the palette, keyboard and buttons through one command registry
  (`src/commands/commands.ts`).
- **Pluggable content** (`src/content/registry.tsx`): note, embed, HTML widget, pane, clock, todo, image.
  - **Embeds** (`src/content/embeds.ts`): paste an ordinary share link and known sites become their embeddable player
    (YouTube, Vimeo, Spotify, SoundCloud, CodePen, Observable, Figma, Google Maps, OpenStreetMap, Desmos, StackBlitz,
    CodeSandbox, Loom, gists, Excalidraw, tldraw, Wikipedia). Pure URL rewriting, no API keys. The pasted link is what's
    stored, so better recipes upgrade old windows. Sites that refuse framing (GitHub, X, …) show an "open" link instead.
  - **HTML widgets** (`src/content/htmlWidget.tsx`): HTML/JS in a sandboxed iframe with a tiny bridge
    (`cwm.state`, `cwm.setState`, `cwm.onState`, `cwm.onTheme`). The code and the state live in the document, so
    widget state persists, undoes, and stays in sync across mirrors (the demo Sketchpad is mirrored into Play and
    Social). Templates: Sketchpad, Counter, Timer, Markdown (loads a library from a CDN), Blank. Hover a widget and
    click `</>` to edit its code; ⌘↵ runs it.

## Keys

The same keys work in every view; each view decides what “move right” or “grow” means in its own terms
(`src/model/moves.ts`). Press ⌥/ in the app for this list.

| | |
|---|---|
| ⌘K | Command palette (acts on the focused window) |
| ⌘P | Go to any window |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ⌥/ | This list |
| ⌥Esc | Leave a text field (then the keys below work) |
| ⌥← ⌥→ ⌥↑ ⌥↓ | Focus the window in that direction on screen |
| ⌥Esc / ⌥↵ | Focus the parent container / go into a container |
| ⌥, / ⌥. | Previous / next tab (nearest tabs container) |
| ⌥C | Center the focused window (scrolling strip, canvas, document) |
| ⌥⇧← ⌥⇧→ ⌥⇧↑ ⌥⇧↓ | Move the window, in its container’s terms; past the end of a tiled container it moves out |
| ⌥= / ⌥- | Grow / shrink (split share, column width, grid span, canvas size, dates…) |
| ⌥[ / ⌥] | Stack into the neighbour on the left / right, or out of a stack (nests a split) |
| ⌥T | Toggle the window’s container between tabs and its previous view |
| ⌥N | New note, right after the focused window |
| ⌥W | Close |
| ⌥M / ⌥⇧M | Move to… / mirror into… |
| ⌥1 … ⌥9 | View the focused container as tabs, split, canvas, floating, grid, dock, document, outline, JSON |

## Dragging

Drag a window by its ⠿ grip, or drag a tab itself. A blue preview shows what the drop will do. Hold ⌥ to mirror instead of move.

- **Into a container:** drop in its middle. Each view places it in its own terms (canvas: x/y, split/grid/tabs: index, dock: side).
- **Into another tab:** drop onto the middle of a tab that holds a container, or hover any tab for about ½s to switch to it, then drop inside.
- **Reorder tabs:** drop on the left or right side of a tab.
- **Beside something (split):** drop near the edge of a window or container. It is replaced by a split holding both.
  Inside canvas and floating views there is no edge-splitting; drops just place the window.
- **Out of everything:** drop on the striped bands around the workspace edge to split the whole desktop.
