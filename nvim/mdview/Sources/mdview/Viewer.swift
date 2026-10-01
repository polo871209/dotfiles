import AppKit
import SwiftUI
import WebKit

private let index = URL(string: "mdview://app/index.html")!

/// The find bar state. main.swift opens it with Cmd-F, and the bar closes itself with Esc or its Done button.
@Observable @MainActor
final class Find {
    var shown = false
}

private struct Root: View {
    let page: WebPage
    @Bindable var find: Find

    var body: some View {
        WebView(page)
            .webViewMagnificationGestures(.enabled)
            // Two-finger swipe walks the same history as Cmd-[ and Cmd-].
            .webViewBackForwardNavigationGestures(.enabled)
            .findNavigator(isPresented: $find.shown)
            // The web view takes every click, so this invisible strip is the only place to drag the window.
            // It goes before ignoresSafeArea, or it sits under the hidden title bar and covers the TOC button.
            .overlay(alignment: .top) {
                Color.clear.frame(height: 24).contentShape(.rect).gesture(WindowDragGesture())
            }
            .ignoresSafeArea()
    }
}

@MainActor
final class Viewer: NSObject, NSWindowDelegate {
    private let page: WebPage
    private let panel: Panel
    /// Starts at launch, so the web process boots while nvim's first message is still in flight.
    private let loaded: Task<Void, any Error>
    private var pending: Message?
    private var busy = false
    /// The newest message, from nvim or from disk.
    private var latest: Message?
    private var watcher: FileWatcher?
    let find = Find()

    override init() {
        var config = WebPage.Configuration()
        config.urlSchemeHandlers[URLScheme("mdview")!] = Assets()
        config.userContentController.add(Bridge(), name: "open")
        let page = WebPage(configuration: config, navigationDecider: Links())
        // Safari > Develop lists the page, for debugging app.js.
        page.isInspectable = true
        self.page = page
        loaded = Task {
            for try await event in page.load(index) where event == .finished { break }
        }

        // Non-activating so the terminal keeps keyboard focus while nvim streams edits.
        panel = Panel(
            contentRect: NSRect(x: 0, y: 0, width: 780, height: 920),
            // .titled keeps rounded corners, shadow, and key focus. The bar itself is hidden below.
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        panel.contentView = NSHostingView(rootView: Root(page: page, find: find))
        panel.center()
        panel.setFrameAutosaveName("mdview")
    }

    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }

    /// Browser Back (-1) and Forward (1). app.js keeps the history.
    func go(_ delta: Int) {
        Task { _ = try? await page.callJavaScript("history.go(delta)", arguments: ["delta": delta]) }
    }

    /// Keeps only the newest message, so a burst of keystrokes costs one render.
    func show(_ message: Message) {
        latest = message
        if watcher?.path != message.path {
            watcher = FileWatcher(path: message.path) { [weak self] text in self?.reload(text) }
        }
        pending = message
        guard !busy else { return }
        busy = true
        Task {
            while let next = pending {
                pending = nil
                await render(next)
            }
            busy = false
        }
    }

    /// An agent or another editor changed the file behind nvim. Disk content shows until the next nvim edit.
    private func reload(_ disk: String) {
        guard let latest else { return }
        // nvim sends the lines joined by \n, with no final newline. "\r\n" is one Character, so replace it first.
        var text = disk.replacing("\r\n", with: "\n")
        if text.hasSuffix("\n") { text.removeLast() }
        // A :w in nvim writes the text that is already on screen.
        guard text != latest.text else { return }
        show(Message(path: latest.path, text: text, line: latest.line))
    }

    private func render(_ message: Message) async {
        do {
            try await loaded.value
        } catch {
            return report(error)
        }
        let file = URL(filePath: message.path)
        // Hidden, but Mission Control and the window switcher still show it.
        panel.title = file.lastPathComponent
        var base = "mdview://file" + file.deletingLastPathComponent().path(percentEncoded: true)
        if !base.hasSuffix("/") { base += "/" }
        do {
            _ = try await page.callJavaScript(
                "mdview.update(html, base, path, line)",
                arguments: ["html": Markdown.html(message.text), "base": base, "path": message.path, "line": message.line]
            )
        } catch {
            report(error)
        }
        if !panel.isVisible { present() }
    }

    /// The panel stays hidden until the first render, then fades in, so it never flashes empty.
    private func present() {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = 1
        }
    }

    private func report(_ error: any Error) {
        FileHandle.standardError.write(Data("mdview: \(error)\n".utf8))
    }
}

/// WebKit drops the click that makes a window key, so the first click on a button or link did nothing.
private final class Panel: NSPanel {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown, !isKeyWindow { makeKey() }
        super.sendEvent(event)
    }
}

/// app.js posts `{path}` when Back or Forward lands on a file other than the one on screen.
private final class Bridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let path = body["path"] as? String else { return }
        openInNvim(path)
    }
}

/// The page never navigates. A clicked web link opens in the browser, and a clicked file link goes to nvim.
private struct Links: WebPage.NavigationDeciding {
    func decidePolicy(for action: WebPage.NavigationAction, preferences: inout WebPage.NavigationPreferences) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url == index { return .allow }
        // Raw HTML such as <meta http-equiv=refresh> must not open anything.
        guard action.navigationType == .linkActivated else { return .cancel }
        switch url.scheme {
        case "http", "https", "mailto":
            NSWorkspace.shared.open(url)
        case "mdview" where url.host() == "file", "file":
            openInNvim(url.path(percentEncoded: false), anchor: url.fragment(percentEncoded: false))
        default:
            break
        }
        return .cancel
    }
}
