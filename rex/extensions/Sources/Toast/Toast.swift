import AppKit
import RexKit
import SwiftUI

private struct ToastRequest: Decodable {
    let text: String
}

@MainActor
public final class ToastHost {
    public static let shared = ToastHost()
    static let socketPath = NSHomeDirectory() + "/Library/Caches/rex-toast.sock"

    private var listener: Listener?
    private var shown: NSView?
    private var hideTask: Task<Void, Never>?

    public func start() {
        listener = Listener(path: Self.socketPath) { line in
            guard let request = try? JSONDecoder().decode(ToastRequest.self, from: line) else {
                return "bad request"
            }
            DispatchQueue.main.async { ToastHost.shared.show(request.text) }
            return "ok"
        }
    }

    private func show(_ text: String) {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow,
            let host = window.contentView?.superview ?? window.contentView
        else { return }
        shown?.removeFromSuperview()
        hideTask?.cancel()
        let theme = Theme.current(for: window.effectiveAppearance)
        let toast = NSHostingView(rootView: ToastView(text: text, theme: theme))
        toast.frame = frame(toast.fittingSize, in: host, of: window)
        host.addSubview(toast, positioned: .above, relativeTo: nil)
        shown = toast
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            await NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.25
                toast.animator().alphaValue = 0
            }
            toast.removeFromSuperview()
            if self?.shown === toast { self?.shown = nil }
        }
    }

    private func frame(_ size: NSSize, in host: NSView, of window: NSWindow) -> NSRect {
        let margin: CGFloat = 16
        let area = host.convert(window.contentLayoutRect, from: nil)
        let position = UserDefaults.standard.string(forKey: "Workspace.notificationPosition")
        let parts = (position ?? "bottom-right").split(separator: "-")
        let top = parts.first == "top"
        let originX =
            switch parts.last {
            case "left": area.minX + margin
            case "center": area.midX - size.width / 2
            default: area.maxX - margin - size.width
            }
        let originY = top == host.isFlipped ? area.minY + margin : area.maxY - margin - size.height
        return NSRect(origin: NSPoint(x: originX, y: originY), size: size).integral
    }
}

private struct ToastView: View {
    let text: String
    let theme: Theme

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.green)
            Text(text).foregroundStyle(theme.foreground).lineLimit(1).truncationMode(.middle)
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: 480)
        .glassEffect(in: .capsule)
    }
}
