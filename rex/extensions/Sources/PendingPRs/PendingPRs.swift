import AppKit
import RexKit

private struct PendingRequest: Decodable {
    let path: String
}

@MainActor
public final class PendingHost {
    public static let shared = PendingHost()
    static let socketPath = NSHomeDirectory() + "/Library/Caches/rex-pending.sock"

    private let model = PendingModel()
    private var listener: Listener?
    private let overlays = OverlayHost()

    public func start() {
        listener = Listener(path: Self.socketPath) { line in
            guard let request = try? JSONDecoder().decode(PendingRequest.self, from: line) else {
                return "bad request"
            }
            DispatchQueue.main.async { PendingHost.shared.toggle(path: request.path) }
            return "ok"
        }
    }

    private func toggle(path: String) {
        let model = model
        let opened = overlays.toggle(
            maxSize: NSSize(width: 760, height: 640),
            content: { theme, close in
                model.onDone = close
                return PendingView(model: model, theme: theme)
            },
            handleKey: { press in Self.handle(press, model: model, path: path) })
        if opened {
            model.query = ""
            model.refresh(path: path)
        }
    }

    private static func handle(_ press: KeyPress, model: PendingModel, path: String) -> KeyResult {
        if let delta = direction(of: press) {
            model.move(by: delta)
            return .handled
        }
        switch (press.modifiers, press.keyCode, press.key.lowercased()) {
        case ([.command, .shift], _, "s"): return .close
        case ([], 36, _), ([], 76, _): model.activate()
        case ([], 123, _) where model.query.isEmpty: model.collapseSelected()
        case ([], 124, _) where model.query.isEmpty: model.expandSelected()
        case ([], 48, _): model.toggleGrouping()
        case ([.command], _, "r"): model.refresh(path: path)
        default: return .ignored
        }
        return .handled
    }

    private static func direction(of press: KeyPress) -> Int? {
        switch (press.modifiers, press.keyCode, press.key) {
        case ([], 125, _), ([.control], _, "n"), ([.control], _, "j"): 1
        case ([], 126, _), ([.control], _, "p"), ([.control], _, "k"): -1
        default: nil
        }
    }
}
