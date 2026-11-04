import AppKit
import SwiftUI

public struct KeyPress {
    public let keyCode: UInt16
    public let key: String
    public let modifiers: NSEvent.ModifierFlags
}

public enum KeyResult {
    case ignored, handled, close
}

/// A card drawn over a Rex window. Escape, a click outside the card, or the window losing focus closes it.
@MainActor
public final class Overlay {
    public var onClose: () -> Void = {}

    private let window: NSWindow
    private let card: NSView
    private let handleKey: (KeyPress) -> KeyResult
    private let backdrop: Backdrop
    private weak var previousResponder: NSResponder?
    private var keyMonitor: Any?
    private var resignObserver: NSObjectProtocol?

    public init(
        window: NSWindow, content: some View, maxSize: NSSize,
        handleKey: @escaping (KeyPress) -> KeyResult
    ) {
        self.window = window
        self.card = NSHostingView(rootView: content)
        self.handleKey = handleKey
        self.backdrop = Backdrop(maxSize: maxSize)
    }

    public func show() {
        // The frame view hosts the content view, so a subview there sits above everything Rex draws.
        guard let host = window.contentView?.superview ?? window.contentView else { return }
        previousResponder = window.firstResponder
        backdrop.card = card
        backdrop.onClick = { [weak self] in self?.close() }
        backdrop.addSubview(card)
        backdrop.frame = host.bounds
        backdrop.autoresizingMask = [.width, .height]
        host.addSubview(backdrop, positioned: .above, relativeTo: nil)
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let press = KeyPress(
                keyCode: event.keyCode, key: event.charactersIgnoringModifiers ?? "",
                modifiers: event.modifierFlags.intersection([.command, .control, .option, .shift]))
            let mine = event.window === self?.window
            let handled = MainActor.assumeIsolated { mine && self?.handle(press) == true }
            return handled ? nil : event
        }
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification, object: window, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.close() } }
    }

    public func close() {
        guard backdrop.superview != nil else { return }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        backdrop.removeFromSuperview()
        window.makeFirstResponder(previousResponder)
        onClose()
    }

    private func handle(_ press: KeyPress) -> Bool {
        if press.modifiers.isEmpty, press.keyCode == 53 {
            close()
            return true
        }
        switch handleKey(press) {
        case .ignored: return false
        case .handled: return true
        case .close:
            close()
            return true
        }
    }
}

/// Holds at most one `Overlay` over the key window and closes it when toggled again.
@MainActor
public final class OverlayHost {
    private var overlay: Overlay?

    public init() {}

    /// Returns true when it opened an overlay. `content` gets the theme and a function that closes the overlay.
    public func toggle(
        maxSize: NSSize,
        content: (Theme, @escaping () -> Void) -> some View,
        handleKey: @escaping (KeyPress) -> KeyResult
    ) -> Bool {
        if let overlay {
            overlay.close()
            return false
        }
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else { return false }
        weak var shown: Overlay?
        let created = Overlay(
            window: window,
            content: content(.current(for: window.effectiveAppearance), { shown?.close() }),
            maxSize: maxSize, handleKey: handleKey)
        shown = created
        created.onClose = { [weak self] in self?.overlay = nil }
        self.overlay = created
        created.show()
        return true
    }
}

private final class Backdrop: NSView {
    var card: NSView?
    var onClick: () -> Void = {}
    private let maxSize: NSSize

    init(maxSize: NSSize) {
        self.maxSize = maxSize
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.2).cgColor
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        let width = min(max(bounds.width * 0.5, 480), maxSize.width)
        let height = min(max(bounds.height * 0.6, 280), maxSize.height)
        let top = isFlipped ? bounds.height * 0.14 : bounds.maxY - bounds.height * 0.14 - height
        card?.frame =
            NSRect(x: bounds.midX - width / 2, y: top, width: width, height: height).integral
    }

    override func mouseDown(with event: NSEvent) {
        if let card, card.frame.contains(convert(event.locationInWindow, from: nil)) { return }
        onClick()
    }
}
