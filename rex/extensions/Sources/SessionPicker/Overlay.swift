import AppKit
import RexKit
import SwiftUI

@MainActor
final class Overlay {
    var onClose: () -> Void = {}

    private let window: NSWindow
    private let model: PickerModel
    private let backdrop = Backdrop()
    private weak var previousResponder: NSResponder?
    private var keyMonitor: Any?
    private var resignObserver: NSObjectProtocol?

    init(window: NSWindow, model: PickerModel) {
        self.window = window
        self.model = model
    }

    func show() {
        // The frame view hosts the content view, so a subview there sits above everything Rex draws.
        guard let host = window.contentView?.superview ?? window.contentView else { return }
        previousResponder = window.firstResponder
        let card = NSHostingView(
            rootView: PickerView(model: model, theme: .current(for: window.effectiveAppearance)))
        backdrop.card = card
        backdrop.onClick = { [weak self] in self?.close() }
        backdrop.addSubview(card)
        backdrop.frame = host.bounds
        backdrop.autoresizingMask = [.width, .height]
        host.addSubview(backdrop, positioned: .above, relativeTo: nil)
        model.onDone = { [weak self] in self?.close() }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let keyCode = event.keyCode
            let key = event.charactersIgnoringModifiers ?? ""
            let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
            let mine = event.window === self?.window
            let handled = MainActor.assumeIsolated {
                mine && self?.handle(keyCode: keyCode, key: key, modifiers: modifiers) == true
            }
            return handled ? nil : event
        }
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification, object: window, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.close() } }
        model.reload()
    }

    func close() {
        guard backdrop.superview != nil else { return }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        backdrop.removeFromSuperview()
        window.makeFirstResponder(previousResponder)
        onClose()
    }

    private func handle(keyCode: UInt16, key: String, modifiers: NSEvent.ModifierFlags) -> Bool {
        switch (modifiers, keyCode, key) {
        case ([], 53, _), ([.command], _, "k"): close()
        case ([], 36, _), ([], 76, _): model.choose()
        case ([], 125, _), ([.control], _, "n"), ([.control], _, "j"): model.move(by: 1)
        case ([], 126, _), ([.control], _, "p"), ([.control], _, "k"): model.move(by: -1)
        case ([.control], _, "x"): model.killSelected()
        case ([], 48, _): model.toggleAll()
        case ([], 124, _) where model.query.isEmpty: model.expandSelected()
        case ([], 123, _) where model.query.isEmpty: model.collapseSelected()
        default: return false
        }
        return true
    }
}

private final class Backdrop: NSView {
    var card: NSView?
    var onClick: () -> Void = {}

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.2).cgColor
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        let width = min(max(bounds.width * 0.5, 480), 680)
        let height = min(max(bounds.height * 0.6, 280), 480)
        let top = isFlipped ? bounds.height * 0.14 : bounds.maxY - bounds.height * 0.14 - height
        card?.frame =
            NSRect(x: bounds.midX - width / 2, y: top, width: width, height: height).integral
    }

    override func mouseDown(with event: NSEvent) {
        if let card, card.frame.contains(convert(event.locationInWindow, from: nil)) { return }
        onClick()
    }
}
