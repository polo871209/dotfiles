import AppKit
import RexKit

struct PickerRequest: Decodable, Sendable {
    let client: String
    let session: String
    let rowsScript: String
    let path: String
}

@MainActor
public final class PickerHost {
    public static let shared = PickerHost()
    static let socketPath = NSHomeDirectory() + "/Library/Caches/rex-session-picker.sock"

    private var listener: Listener?
    private let overlays = OverlayHost()

    public func start() {
        listener = Listener(path: Self.socketPath) { line in
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            guard let request = try? decoder.decode(PickerRequest.self, from: line) else {
                return "bad request"
            }
            DispatchQueue.main.async { PickerHost.shared.toggle(request) }
            return "ok"
        }
    }

    private func toggle(_ request: PickerRequest) {
        let model = PickerModel(
            rex: Rex(
                client: request.client, current: request.session, rowsScript: request.rowsScript,
                path: request.path))
        let opened = overlays.toggle(
            maxSize: NSSize(width: 680, height: 480),
            content: { theme, close in
                model.onDone = close
                return PickerView(model: model, theme: theme)
            },
            handleKey: { press in Self.handle(press, model: model) })
        if opened { model.reload() }
    }

    private static func handle(_ press: KeyPress, model: PickerModel) -> KeyResult {
        switch (press.modifiers, press.keyCode, press.key) {
        case ([.command], _, "k"): return .close
        case ([], 36, _), ([], 76, _): model.choose()
        case ([], 125, _), ([.control], _, "n"), ([.control], _, "j"): model.move(by: 1)
        case ([], 126, _), ([.control], _, "p"), ([.control], _, "k"): model.move(by: -1)
        case ([.control], _, "x"): model.killSelected()
        case ([], 48, _): model.toggleAll()
        case ([], 124, _) where model.query.isEmpty: model.expandSelected()
        case ([], 123, _) where model.query.isEmpty: model.collapseSelected()
        default: return .ignored
        }
        return .handled
    }
}
