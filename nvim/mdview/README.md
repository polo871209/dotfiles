# mdview

A read-only markdown viewer for nvim. It is a native macOS panel that uses the system WebKit, not a browser. `<leader>tm` in a markdown buffer opens and closes it.

## Build and test

The first `<leader>tm` on a machine runs the build, so a manual build is only for changes. Run these from the dotfiles root. Both commands download the pinned assets first.

```sh
just mdview        # release build at .build/release/mdview, which nvim/lua/mdview.lua runs
just mdview test   # Swift tests for the parser options and the asset routes
```

## Where each part lives

The nvim side is two files: `nvim/lua/mdview.lua` starts the process and streams the buffer, and `nvim/after/ftplugin/markdown.lua` sets the keymap. The viewer side is this directory.

- `Sources/mdview/Protocol.swift` holds the JSON lines that pass between nvim and the viewer. Change both ends together.
- `Sources/mdview/Viewer.swift` owns the panel, the `WebPage`, and link handling. `main.swift` sets up the app, the keys, and the stdin reader. `FileWatcher.swift` re-renders the page when the file content changes on disk, for example after an agent edit.
- `Sources/mdview/Markdown.swift` calls cmark-gfm. `Assets.swift` serves `mdview://app/` from `Resources/` and `mdview://file/` from disk, for images only.
- `Sources/mdview/Resources/app.js` post-processes the HTML the way GitHub does (alerts, task lists, heading ids), draws code and diagrams, builds the table of contents, and keeps the Back and Forward history.
- `Sources/mdview/Resources/style.css` holds only the overrides on top of `github-markdown.css`.

## Change a dependency

The browser asset versions are variables at the top of `justfile`. The `vendor/` directory is git-ignored and re-downloaded on every build. swift-cmark is pinned by commit in `Package.swift`, because its tags are not semver.

## Debug the page

Open Safari > Develop > your Mac > mdview while the viewer is open. The page is inspectable, so the console shows app.js errors. Swift errors go to stderr, and nvim shows them as a warning when the viewer exits.
