# Rex

## Rex app extensions

<!-- AGENT: when you add, remove, or materially change an extension, update its bullet below. -->

`rex/extensions` builds one dylib that `just rex patch` injects into `/Applications/Rex Beta.app`. Each extension is one Swift target in `rex/extensions/Sources/` and has a public `start()`, which `RexExtensions/Start.swift` calls. Code that several extensions use lives in `RexKit`.

- **`SessionPicker`** — on ⌘K, draws a picker over the Rex window to switch sessions, open directories, and jump to agent panes. `init.lua` opens it through `~/Library/Caches/rex-session-picker.sock`.
- **`ClaudeUsage`** — shows the Claude plan and 5h and 7d usage bars above the sidebar buttons, with reset times on hover. It uses the Claude login from `~/.pi/agent/auth.json` and refreshes every 5 minutes and on wake.

To add an extension, add a target in `Package.swift` that depends on `RexKit`, add it to the `RexExtensions` dependencies, and call its `start()` in `Start.swift`.

## The extensions depend on private Rex internals

Rex has no API for app extensions, so they break in ways Rex does not announce:

- A Rex update installs the official app again, which loads no extension. Run `just rex patch`, then reopen Rex.
- `ClaudeUsage` finds the private AppKit views `SidebarFooterView` and the `NSScrollView` beside it by class name, and it adds its height to that scroll view's bottom inset. If a Rex update renames these views or changes how it sets the insets, the panel disappears or covers session rows, and Rex keeps working. To get the current names, run `strings -a "/Applications/Rex Beta.app/Contents/MacOS/Rex" | grep Sidebar`.
- `ClaudeUsage` refreshes the Claude OAuth token itself, because the panel must work when no pi runs. A refresh rotates the refresh token, so `ClaudeLogin.swift` copies pi's protocol: the `auth.json.lock` directory, the 5-minute margin, and the token request from pi-ai's `anthropic.js`. If pi changes any of these, pi and the panel can each invalidate the other's login. After a pi update, compare `ClaudeLogin.swift` with `pi-ai/dist/auth/oauth/anthropic.js` and `pi-ai/dist/auth/resolve.js`.
- `ClaudeUsage` reads private Swift properties of `SidebarFooterView` by reflection: `foregroundColor` for the text color, and `filterButton`, `newSessionButton`, and `addRemoteHostButton` to sit above the button row. It also loads `block-glyph-claude` from the app's `SuperBlockIcons_SuperBlockIcons.bundle`. If Rex renames any of these, the panel falls back to the theme foreground, the top of the footer, or no icon.
- To start Rex without any extension, set `REX_EXTENSIONS_DISABLE=1` in its environment.
