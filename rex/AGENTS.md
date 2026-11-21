# Rex

`rex/extensions` builds one dylib that `just rex` injects into `/Applications/Rex Beta.app`, then reloads `init.lua` and reopens Rex. Each extension is a Swift target in `Sources/` with a public `start()` that `RexExtensions/Start.swift` calls. Shared code lives in `RexKit`.

<!-- AGENT: when you add or remove an extension, update this list. -->

- `SessionPicker`: the ⌘K session picker.
- `PendingPRs`: the ⇧⌘S card of open PRs and branches without a PR.
- `ClaudeUsage`: Claude 5h and 7d usage above the sidebar buttons.
- `Toast`: a short in-app notice at Rex's notification position, for example after ⌘Y copies the pane directory.

## Extensions use private Rex internals

Rex has no extension API, so a Rex update can break an extension without warning:

- A Rex update removes the patch. The launch agent `local.rex-extensions` runs `patch-rex` again and logs to `~/Library/Logs/rex-extensions.log`.
- `patch-rex` re-signs Sparkle's `Autoupdate` ad hoc so that updates work. If an update fails, run `just rex unpatch`, update, then run `just rex`.
- `ClaudeUsage` finds `SidebarFooterView` and its `NSScrollView` by class name and reads their private properties by reflection. If the panel disappears, get the current names with `strings -a "/Applications/Rex Beta.app/Contents/MacOS/Rex" | grep Sidebar`.
- `ClaudeLogin.swift` copies pi's OAuth refresh protocol, because a refresh rotates the token for both. After a pi update, compare it with `pi-ai/dist/auth/oauth/anthropic.js` and `pi-ai/dist/auth/resolve.js`.
- `Toast` reads Rex's `Workspace.notificationPosition` default and falls back to the bottom right. If the toast ignores Settings => Notifications => Notification position, get the current key with `strings -a "/Applications/Rex Beta.app/Contents/MacOS/Rex" | grep -i notificationPosition`.
- To start Rex without extensions, set `REX_EXTENSIONS_DISABLE=1`.
