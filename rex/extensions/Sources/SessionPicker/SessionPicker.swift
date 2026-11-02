import AppKit

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
    private var overlay: Overlay?

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
        if let overlay {
            overlay.close()
            return
        }
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else { return }
        let rex = Rex(
            client: request.client, current: request.session, rowsScript: request.rowsScript,
            path: request.path)
        let overlay = Overlay(window: window, model: PickerModel(rex: rex))
        overlay.onClose = { [weak self] in self?.overlay = nil }
        self.overlay = overlay
        overlay.show()
    }
}
