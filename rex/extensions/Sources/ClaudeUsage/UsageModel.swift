import AppKit
import Observation

@MainActor
@Observable
final class UsageModel {
    static let refreshInterval: TimeInterval = 5 * 60

    private(set) var usage: Usage?
    private(set) var plan: String?
    private(set) var fetchedAt: Date?
    private(set) var problem: String?
    private(set) var now = Date()
    @ObservationIgnored private var loading = false
    @ObservationIgnored private var timers: [Timer] = []
    @ObservationIgnored private var wakeObserver: NSObjectProtocol?

    var nextRefresh: Date? { timers.first?.fireDate }

    func start() {
        refresh()
        let interval = Self.refreshInterval
        timers = [
            Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.refresh() }
            },
            Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.now = Date() }
            },
        ]
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } }
    }

    private func refresh() {
        guard !loading else { return }
        loading = true
        Task {
            do {
                let token = try await ClaudeLogin.accessToken()
                async let plan = try? UsageAPI.plan(token: token)
                usage = try await UsageAPI.fetch(token: token)
                self.plan = await plan ?? self.plan
                fetchedAt = Date()
                problem = nil
            } catch {
                problem = error.localizedDescription
            }
            now = Date()
            loading = false
        }
    }
}
