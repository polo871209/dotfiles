import AppKit
import RexKit
import SwiftUI

/// Puts a usage panel above the footer of every Rex sidebar. Rex has no API for sidebar content,
/// so this finds its private views by class name and does nothing when they are missing.
@MainActor
public final class UsagePanels {
    public static let shared = UsagePanels()

    private let model = UsageModel()
    private var panels: [ObjectIdentifier: UsagePanel] = [:]
    private var keyObserver: NSObjectProtocol?

    public func start() {
        model.start()
        attach()
        keyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main
        ) { _ in MainActor.assumeIsolated { UsagePanels.shared.attach() } }
    }

    private func attach() {
        panels = panels.filter { $0.value.isAttached }
        for window in NSApp.windows {
            guard let root = window.contentView?.superview ?? window.contentView else { continue }
            for footer in Self.views(in: root, classSuffix: "SidebarFooterView")
            where panels[ObjectIdentifier(footer)] == nil {
                if let panel = UsagePanel(footer: footer, model: model) {
                    panels[ObjectIdentifier(footer)] = panel
                }
            }
        }
    }

    private static func views(in view: NSView, classSuffix: String) -> [NSView] {
        if NSStringFromClass(type(of: view)).hasSuffix(classSuffix) { return [view] }
        return view.subviews.flatMap { views(in: $0, classSuffix: classSuffix) }
    }
}

@MainActor
private final class UsagePanel {
    private weak var footer: NSView?
    private weak var scrollView: NSScrollView?
    private let model: UsageModel
    private let hosting: NSHostingView<UsageView>
    private var frameObserver: NSObjectProtocol?
    private var ownInset: (bottom: CGFloat, added: CGFloat)?

    init?(footer: NSView, model: UsageModel) {
        guard let container = footer.superview else { return nil }
        self.footer = footer
        self.model = model
        scrollView = container.subviews.lazy.compactMap { $0 as? NSScrollView }.first
        hosting = NSHostingView(
            rootView: UsageView(model: model, style: UsageStyle(footer: footer)))
        container.addSubview(hosting, positioned: .above, relativeTo: footer)
        footer.postsFrameChangedNotifications = true
        frameObserver = NotificationCenter.default.addObserver(
            forName: NSView.frameDidChangeNotification, object: footer, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.layout() } }
        layout()
    }

    isolated deinit {
        if let frameObserver { NotificationCenter.default.removeObserver(frameObserver) }
        hosting.removeFromSuperview()
    }

    var isAttached: Bool { footer?.window != nil }

    private func layout() {
        guard let footer, footer.superview === hosting.superview, let container = footer.superview
        else { return }
        let style = UsageStyle(footer: footer)
        if style != hosting.rootView.style {
            hosting.rootView = UsageView(model: model, style: style)
        }
        let flipped = container.isFlipped
        let height = hosting.fittingSize.height
        let footerTop = flipped ? footer.frame.minY : footer.frame.maxY
        let anchor = Self.buttonsTop(in: footer, container: container) ?? footerTop
        let gap: CGFloat = 4
        let originY = flipped ? anchor - gap - height : anchor + gap
        hosting.frame = NSRect(
            x: footer.frame.minX, y: originY, width: footer.frame.width, height: height)
        hosting.isHidden = footer.isHidden
        let panelTop = flipped ? originY : originY + height
        reserveScrollSpace(max(0, flipped ? footerTop - panelTop : panelTop - footerTop))
    }

    /// The footer is taller than its button row, so the panel sits on the buttons, not on the footer.
    private static func buttonsTop(in footer: NSView, container: NSView) -> CGFloat? {
        let names = ["filterButton", "newSessionButton", "addRemoteHostButton"]
        let frames = Mirror(reflecting: footer).children
            .filter { child in names.contains { child.label?.hasSuffix($0) == true } }
            .compactMap { $0.value as? NSView }
            .filter { !$0.isHiddenOrHasHiddenAncestor && $0.alphaValue > 0 && $0.superview != nil }
            .map { container.convert($0.bounds, from: $0) }
        return container.isFlipped ? frames.map(\.minY).min() : frames.map(\.maxY).max()
    }

    /// Rex sets the sidebar's insets itself, so keep its value as the base and add the panel on top.
    private func reserveScrollSpace(_ height: CGFloat) {
        guard let scrollView, !scrollView.automaticallyAdjustsContentInsets else { return }
        var insets = scrollView.contentInsets
        let base =
            ownInset.flatMap { insets.bottom == $0.bottom ? $0.bottom - $0.added : nil }
            ?? insets.bottom
        let bottom = base + height
        ownInset = (bottom, height)
        guard insets.bottom != bottom else { return }
        insets.bottom = bottom
        scrollView.contentInsets = insets
    }
}

/// Colors that match the Rex sidebar: its own text color, and warning colors from the Rex theme.
struct UsageStyle: Equatable {
    let foreground: Color
    let warning: Color
    let critical: Color

    @MainActor init(footer: NSView) {
        let theme = Theme.current(for: footer.effectiveAppearance)
        foreground = Self.sidebarForeground(footer).map(Color.init(nsColor:)) ?? theme.foreground
        warning = theme.yellow
        critical = theme.red
    }

    func fill(percent: Double) -> Color {
        percent >= 90 ? critical : percent >= 75 ? warning : foreground.opacity(0.7)
    }

    // Rex keeps the sidebar text color in a private Swift property, which only reflection reads.
    @MainActor private static func sidebarForeground(_ footer: NSView) -> NSColor? {
        Mirror(reflecting: footer).children.lazy
            .first { $0.label == "foregroundColor" }
            .flatMap { $0.value as? NSColor }
    }
}

private struct UsageView: View {
    let model: UsageModel
    let style: UsageStyle
    @State private var hovering = false

    var body: some View {
        VStack(spacing: 6) {
            UsageHeader(plan: model.plan, style: style).padding(.bottom, 2)
            UsageBar(label: "5h", window: model.usage?.session, now: model.now, style: style)
            UsageBar(label: "7d", window: model.usage?.weekly, now: model.now, style: style)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .popover(isPresented: $hovering, arrowEdge: .trailing) {
            UsageDetail(model: model, style: style)
        }
    }
}

private struct UsageHeader: View {
    // The glyph Rex shows on a tab that runs claude.
    @MainActor private static let claudeGlyph = Bundle.main
        .url(forResource: "SuperBlockIcons_SuperBlockIcons", withExtension: "bundle")
        .flatMap(Bundle.init(url:))?
        .image(forResource: "block-glyph-claude")

    let plan: String?
    let style: UsageStyle

    var body: some View {
        HStack(spacing: 6) {
            if let glyph = Self.claudeGlyph {
                Image(nsImage: glyph)
                    .resizable()
                    .renderingMode(.template)
                    .foregroundStyle(Color(nsColor: .windowBackgroundColor))
                    .padding(2)
                    .frame(width: 14, height: 14)
                    .background(
                        RoundedRectangle(cornerRadius: 3.5).fill(style.foreground.opacity(0.9)))
            }
            Text("Claude")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(style.foreground.opacity(0.7))
            Spacer(minLength: 4)
            if let plan {
                Text(plan)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(style.foreground.opacity(0.6))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(style.foreground.opacity(0.1)))
            }
        }
    }
}

private struct UsageBar: View {
    let label: String
    let window: Usage.Window?
    let now: Date
    let style: UsageStyle

    var body: some View {
        let percent = window?.percent(now: now)
        HStack(spacing: 8) {
            Text(label)
                .foregroundStyle(style.foreground.opacity(0.5))
                .frame(width: 16, alignment: .leading)
            Capsule()
                .fill(style.foreground.opacity(0.12))
                .frame(height: 4)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(style.fill(percent: percent ?? 0))
                            .frame(width: proxy.size.width * (percent ?? 0) / 100)
                    }
                }
            Text(percent.map { "\(Int($0.rounded()))%" } ?? "–")
                .foregroundStyle(style.foreground.opacity(0.7))
                .frame(width: 30, alignment: .trailing)
        }
        .font(.system(size: 11, weight: .medium).monospacedDigit())
    }
}

private struct UsageDetail: View {
    let model: UsageModel
    let style: UsageStyle

    var body: some View {
        let now = model.now
        let windows =
            [model.usage?.session, model.usage?.weekly].compactMap { $0 }
            + (model.usage?.weeklyModels ?? [])
        VStack(alignment: .leading, spacing: 10) {
            Text("Claude usage").font(.system(size: 12, weight: .semibold))
            if !windows.isEmpty {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    ForEach(windows, id: \.name) { window in
                        let percent = window.percent(now: now)
                        GridRow {
                            Text(window.name).foregroundStyle(.secondary)
                            Text("\(Int(percent.rounded()))%")
                                .foregroundStyle(style.fill(percent: percent))
                                .gridColumnAlignment(.trailing)
                            Text(resetText(window.resetsAt, now: now)).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if let problem = model.problem {
                Text(problem).foregroundStyle(style.critical).fixedSize(
                    horizontal: false, vertical: true)
            }
            Text(refreshText(now: now)).foregroundStyle(.tertiary)
        }
        .font(.system(size: 11).monospacedDigit())
        .padding(14)
        .frame(width: 300, alignment: .leading)
    }

    private func resetText(_ resetsAt: Date?, now: Date) -> String {
        guard let resetsAt, resetsAt > now else { return "reset" }
        return
            "resets \(UsageFormat.clock(resetsAt, now: now)), in \(UsageFormat.countdown(to: resetsAt, now: now))"
    }

    private func refreshText(now: Date) -> String {
        let updated =
            model.fetchedAt.map { "Updated \(UsageFormat.age(since: $0, now: now))" }
            ?? "Not loaded yet"
        guard let next = model.nextRefresh else { return updated }
        return "\(updated) · next refresh in \(UsageFormat.countdown(to: next, now: now))"
    }
}
