# Game Menu Tabs

A Vortex extension for the per-game menu (Browse, Mods, Collections, Tools, Health check, Profiles, Game settings) in the new layout. It lets you:

- **Reorder the tabs.** The game opens on the top tab that is shown.
- **Hide tabs** you don't use.
- **Always open the top tab** when you pick a game in the sidebar, instead of Browse or whatever tab you last used for that game.

Out of the box, Mods is at the top and Browse and Collections are hidden. It doesn't depend on any other extension. Written for Vortex 2.11.0.

## Install

1. Close Vortex.
2. Double-click `install.bat`. It copies `info.json` and `index.js` to `%APPDATA%\Vortex\plugins\Game Menu Tabs\`. Run it again after changing the code; it replaces the old files.
3. Start Vortex. **Game Menu Tabs** should appear on the Extensions page, enabled, and Mods should be the first tab.

To uninstall, remove it from the Extensions page, or delete that folder while Vortex is closed. The menu goes back to Vortex's order on the next start.

## Settings

**Settings > Game Menu** lists every per-game tab:

- The checkbox shows or hides a tab.
- The arrows move it up or down.
- **Always open the top tab when you pick a game** is on by default. Turn it off to get Vortex's behaviour back: it reopens the tab you last used for that game in this session.
- **Reset to defaults** puts Mods first and hides Browse and Collections again.
- **Restart Vortex** restarts it so a new order takes effect. A tab you hide disappears the next time you switch games.

Some tabs only appear for some games, such as Plugins and Load order. They're still listed, marked "not used by the current game". Tabs that Vortex or another extension adds later go to the bottom of your order, so a new tab never takes the top spot.

## Limits

- **Tools and Game settings** are built into Vortex itself, not registered by an extension. They can't be hidden, and Tools always stays above Game settings. Every other tab can go anywhere around them.
- **Order changes need a restart.** Vortex builds the menu's tab list once, when its window first opens.
- **Hidden tabs' hotkeys** (B for Browse, C for Collections) open the top tab instead.
- **The Mods/Collections links at the top of the Browse page** aren't changed, but you only see them if Browse is shown.

## How it works

Vortex sorts the per-game tabs by each page's `priority` and opens the first one whose `visible()` is true when you pick a game. Browse registers with priority 0 and Collections with 10, both above Mods (1). That is why Browse opens first. (`views/components/Spine/SpineContext.tsx`, `contexts/PagesContext.tsx`)

Vortex creates the page objects from the extensions' `registerMainPage` calls when it first draws the main window, and keeps them. That happens after every extension's `once()` has run. Until then, only the loading screen is drawn, and it is given Vortex's ExtensionManager as a prop. (`renderer.tsx`)

So in `once()` the extension:

1. finds the ExtensionManager through the loading screen's React tree;
2. reads every per-game page registration;
3. wraps the ExtensionManager's `apply()` so each per-game page is built with a priority that follows your order, and with a `visible()` that also checks your hidden list.

Nothing in Vortex's files is changed. The other extensions' registrations aren't changed either: the extension passes Vortex modified copies of their options.

For **Always open the top tab**, it notices clicks on games in the far-left sidebar. When that game becomes active, it opens the top tab, and replaces the page Vortex opens for it in the next second. Clicks on tabs after that are left alone.

## If it stops working

A future Vortex version may start differently or build the menu another way. The extension then does nothing: the menu keeps Vortex's order and nothing breaks. **Settings > Game Menu** shows the status, and any error is written to `%APPDATA%\Vortex\vortex.log` as a `game-menu-tabs` warning.

## What was verified

- **Source:** checked against the Vortex 2.11.0 source, taken from the source map inside the installed `app.asar`.
- **Simulation:** run with Vortex's own Electron in Node mode against a mock of Vortex's page registration, sorting and filtering. It tested the default order, a custom order around Tools and Game settings, hiding, a hotkey to a hidden tab, and a game switch where Vortex opens Browse.
- **Not tested inside Vortex yet.**
