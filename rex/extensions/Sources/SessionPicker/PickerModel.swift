import Observation
import RexKit

@MainActor @Observable
final class PickerModel {
    var query = "" {
        didSet { selection = 0 }
    }
    var selection = 0
    var error: String?
    private(set) var expanded: Set<String> = []
    private(set) var rows: [Row] = []
    private(set) var loaded = false
    private(set) var busy = false
    @ObservationIgnored let rex: Rex
    @ObservationIgnored var onDone: () -> Void = {}

    init(rex: Rex) {
        self.rex = rex
    }

    var isFiltering: Bool { query.contains { !$0.isWhitespace } }

    var listed: [Row] {
        rows.filter { $0.kind != .agent || $0.sessionID.map(expanded.contains) == true }
    }

    var visible: [Row] {
        let listed = listed
        guard isFiltering else { return listed }
        return listed.enumerated()
            .compactMap { index, row in
                Fuzzy.score(query, in: row.searchText).map { (score: $0, index: index, row: row) }
            }
            .sorted { ($0.score, $0.index) < ($1.score, $1.index) }
            .map(\.row)
    }

    var selected: Row? {
        let rows = visible
        return rows.indices.contains(selection) ? rows[selection] : nil
    }

    var agentStates: [String: [String]] {
        rows.reduce(into: [:]) { states, row in
            if row.kind == .agent, let session = row.sessionID {
                states[session, default: []].append(row.state ?? "")
            }
        }
    }

    var allExpanded: Bool { expanded == Set(agentStates.keys) }

    func expandSelected() {
        if selected?.kind == .agent { return choose() }
        guard let session = selected?.sessionID, agentStates[session] != nil else { return }
        keepingSelection { expanded.insert(session) }
    }

    func collapseSelected() {
        guard let session = selected?.sessionID else { return }
        keepingSelection { expanded.remove(session) }
    }

    func toggleAll() {
        keepingSelection { expanded = allExpanded ? [] : Set(agentStates.keys) }
    }

    /// Keeps the selection on the same row, or on the session of a hidden agent.
    private func keepingSelection(_ change: () -> Void) {
        let target = selected
        let session = target.flatMap { row in
            rows.first { $0.kind == .session && $0.sessionID == row.sessionID }
        }
        change()
        let visible = visible
        selection =
            [target, session].compactMap { $0 }.lazy
            .compactMap { row in visible.firstIndex { $0.id == row.id } }.first ?? 0
    }

    func reload() {
        let rex = rex
        Task {
            let result = await Task.detached { Result { try rex.rows() } }.value
            loaded = true
            switch result {
            case .success(let rows): self.rows = rows
            case .failure(let error): self.error = error.localizedDescription
            }
            selection = min(selection, max(visible.count - 1, 0))
        }
    }

    func move(by delta: Int) {
        let count = visible.count
        guard count > 0 else { return }
        selection = (selection + delta + count) % count
    }

    /// Runs off the main thread: switching makes the server queue session.select back to this app.
    func choose() {
        guard let row = selected, !busy else { return }
        run { rex in
            try rex.open(row)
        } then: { [weak self] in
            self?.onDone()
        }
    }

    func killSelected() {
        guard let row = selected, row.kind == .session, !row.isCurrent, let session = row.sessionID,
            !busy
        else { return }
        run { rex in
            try rex.kill(session: session)
        } then: { [weak self] in
            self?.reload()
        }
    }

    private func run(
        _ work: @escaping @Sendable (Rex) throws -> Void, then done: @escaping () -> Void
    ) {
        busy = true
        let rex = rex
        Task {
            let result = await Task.detached { Result { try work(rex) } }.value
            busy = false
            switch result {
            case .success: done()
            case .failure(let error): self.error = error.localizedDescription
            }
        }
    }
}
