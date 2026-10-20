# mdview

A read-only markdown and HTML viewer for nvim. It is a native macOS panel that uses the system WebKit, not a browser. `<leader>tm` in a markdown or HTML buffer opens and closes it. In the viewer, the same keys (Space t m) close it. The viewer shows the current buffer in the dark Kanagawa Wave style of the blog at `/Users/polo/app/blog`. For markdown, the viewer and the nvim window scroll together, from either side.

Every code block, in markdown and in HTML, has a copy button in its top-right corner that shows on hover.

An HTML file renders as its own page, with its relative files and its scripts. `html.css` replaces the page's colors and fonts with the blog's, and inverts inline SVG diagrams so that they turn dark. The page cannot reach nvim or pi, and it loads files from disk only under its own directory. Scroll sync works in markdown only.

To send a review comment to pi, select text in the viewer and press Space Space. Type the comment and press Enter. pi gets a line-numbered snapshot of the selected source lines, then the comment, which starts a turn or steers the running one. If two or more pi run in the tmux session, the comment box lists them the way the tmux tabs show them, and you press the tmux window number. Later comments on the same buffer go to that pi without asking, until it stops. A partly selected block counts whole. Comments work in HTML files too, where the selection maps to the source lines of the selected elements. This needs nvim inside tmux with a pi that loads `tmux-bridge.ts`.

## Build and test

The first `<leader>tm` on a machine runs the build, so a manual build is only for changes. Run these from the dotfiles root. Both commands download the pinned assets first.

```sh
just mdview        # release build at .build/release/mdview, which nvim/lua/mdview.lua runs
just mdview test   # Swift tests for the parser options and the asset routes
```

## Where each part lives

The nvim side is `nvim/lua/mdview.lua`, which starts the process and streams the buffer, and `nvim/after/ftplugin/markdown.lua`, and `nvim/after/ftplugin/html.lua`, which set the keymap through `ft.preview()` in `nvim/lua/ft.lua`. Review comments go through `nvim/lua/pi.lua`, the same path as the visual-mode `<leader><leader>`. The viewer side is this directory.

- `Sources/mdview/Protocol.swift` holds the JSON lines that pass between nvim and the viewer. Change both ends together.
- `Sources/mdview/Viewer.swift` owns the panel, one `WebPage` for markdown and one for HTML files, and link handling. `main.swift` sets up the app, the keys, and the stdin reader. `FileWatcher.swift` re-renders the page when the file content changes on disk, for example after an agent edit.
- `Sources/mdview/Markdown.swift` calls cmark-gfm. `HTMLSource.swift` adds the source line of each start tag to an HTML file, for comments. `Assets.swift` serves `mdview://app/` from `Resources/` and `mdview://file/` from disk: images for markdown, and any file under its own directory for an HTML file.
- `Sources/mdview/Resources/app.js` post-processes the markdown HTML the way GitHub does (alerts, task lists, heading ids), highlights code with Shiki, draws diagrams, builds the table of contents, syncs the scroll, and keeps the Back and Forward history.
- `Sources/mdview/Resources/copy.js` adds the copy buttons, and `comment.js` adds the review comment box. Both run on both pages. On the HTML page they run in their own content world, so the file's scripts cannot write to the clipboard or send to pi.
- `Sources/mdview/Resources/theme.css` holds the palette, the Fira Code font, the copy button, and the comment box. `style.css` styles the markdown page, and `html.css` restyles HTML files.

## Change a dependency

The browser asset versions are variables at the top of `justfile`. The `vendor/` directory is git-ignored and re-downloaded on every build. Shiki is bundled with esbuild into `vendor/shiki/`, one file per grammar and theme, and the page loads a grammar only when a code block uses it. swift-cmark is pinned by commit in `Package.swift`, because its tags are not semver.

## Debug the page

Open Safari > Develop > your Mac > mdview while the viewer is open. The page is inspectable, so the console shows app.js errors. Swift errors go to stderr, and nvim shows them as a warning when the viewer exits.
