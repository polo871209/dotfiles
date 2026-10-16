import AppKit
import SwiftUI
import WebKit

private let index = URL(string: "mdview://app/index.html")!

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
    private let loaded: Task<Void, any Error>
    private var pending: Message?
    private var busy = false
    private var latest: Message?
    private var watcher: FileWatcher?
    let find = Find()
    /// True while a text field in the page has focus, so key shortcuts must not fire.
    private(set) var editing = false

    override init() {
        var config = WebPage.Configuration()
        config.urlSchemeHandlers[URLScheme("mdview")!] = Assets()
        let bridge = Bridge()
        for name in ["open", "scroll", "comment", "editing"] {
            config.userContentController.add(bridge, name: name)
        }
        let page = WebPage(configuration: config, navigationDecider: Links())
        page.isInspectable = true
        self.page = page
        loaded = Task {
            for try await event in page.load(index) where event == .finished { break }
        }

        panel = Panel(
            contentRect: NSRect(x: 0, y: 0, width: 780, height: 920),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()
        bridge.scrolled = { [weak self] scroll in
            if self?.latest?.path == scroll.path { self?.latest?.top = scroll.top }
        }
        bridge.editing = { [weak self] editing in self?.editing = editing }
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

    func go(_ delta: Int) {
        Task { _ = try? await page.callJavaScript("history.go(delta)", arguments: ["delta": delta]) }
    }

    func show(_ message: Message) {
        let scrollOnly = !busy && message.path == latest?.path && message.text == latest?.text
        latest = message
        if watcher?.path != message.path {
            watcher = FileWatcher(path: message.path) { [weak self] text in self?.reload(text) }
        }
        if scrollOnly { return scroll(to: message.top) }
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

    func choose(_ request: Choose) {
        let listeners = request.choose.map { ["sock": $0.sock, "window": $0.window, "label": $0.label] }
        Task {
            do {
                _ = try await page.callJavaScript("mdview.choose(listeners)", arguments: ["listeners": listeners])
            } catch {
                report(error)
            }
        }
    }

    func sent(_ result: Sent) {
        Task {
            do {
                _ = try await page.callJavaScript("mdview.sent(ok, info)", arguments: ["ok": result.sent, "info": result.info])
            } catch {
                report(error)
            }
        }
    }

    private func scroll(to top: Int) {
        Task {
            do {
                _ = try await page.callJavaScript("mdview.scroll(top)", arguments: ["top": top])
            } catch {
                report(error)
            }
        }
    }

    private func reload(_ disk: String) {
        guard let latest else { return }
        // nvim sends the lines joined by \n, with no final newline. "\r\n" is one Character, so replace it first.
        var text = disk.replacing("\r\n", with: "\n")
        if text.hasSuffix("\n") { text.removeLast() }
        guard text != latest.text else { return }
        show(Message(path: latest.path, text: text, top: latest.top))
    }

    private func render(_ message: Message) async {
        do {
            try await loaded.value
        } catch {
            return report(error)
        }
        let file = URL(filePath: message.path)
        panel.title = file.lastPathComponent
        var base = "mdview://file" + file.deletingLastPathComponent().path(percentEncoded: true)
        if !base.hasSuffix("/") { base += "/" }
        do {
            _ = try await page.callJavaScript(
                "mdview.update(html, base, path, top)",
                arguments: ["html": Markdown.html(message.text), "base": base, "path": message.path, "top": message.top]
            )
        } catch {
            report(error)
        }
        if !panel.isVisible { present() }
    }

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

private final class Bridge: NSObject, WKScriptMessageHandler {
    var scrolled: (Scroll) -> Void = { _ in }
    var editing: (Bool) -> Void = { _ in }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "editing" {
            return editing(message.body as? Bool ?? false)
        }
        guard let body = message.body as? [String: Any], let path = body["path"] as? String else { return }
        switch message.name {
        case "scroll":
            guard let top = body["top"] as? Int else { return }
            let scroll = Scroll(path: path, top: top)
            scrolled(scroll)
            toNvim(scroll)
        case "comment":
            guard let comment = body["comment"] as? String, let sline = body["sline"] as? Int, let eline = body["eline"] as? Int else { return }
            toNvim(Comment(comment: comment, path: path, sline: sline, eline: eline, target: body["target"] as? String))
        default:
            toNvim(Open(open: path, anchor: nil))
        }
    }
}

private struct Links: WebPage.NavigationDeciding {
    func decidePolicy(for action: WebPage.NavigationAction, preferences: inout WebPage.NavigationPreferences) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url == index { return .allow }
        guard action.navigationType == .linkActivated else { return .cancel }
        switch url.scheme {
        case "http", "https", "mailto":
            NSWorkspace.shared.open(url)
        case "mdview" where url.host() == "file", "file":
            toNvim(Open(open: url.path(percentEncoded: false), anchor: url.fragment(percentEncoded: false)))
        default:
            break
        }
        return .cancel
    }
}
