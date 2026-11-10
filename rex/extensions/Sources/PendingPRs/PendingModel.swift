import AppKit
import Observation
import RexKit

enum Loadable<Value> {
    case loading
    case failed(String)
    case loaded(Value)

    var value: Value? {
        if case .loaded(let value) = self { value } else { nil }
    }
}

enum Item: Identifiable {
    case pullRequest(PullRequest)
    case stray(StrayBranch)

    var id: String {
        switch self {
        case .pullRequest(let pullRequest): pullRequest.url.absoluteString
        case .stray(let branch): branch.id
        }
    }

    var url: URL {
        switch self {
        case .pullRequest(let pullRequest): pullRequest.url
        case .stray(let branch): branch.url
        }
    }

    var repo: String {
        switch self {
        case .pullRequest(let pullRequest): pullRequest.repo
        case .stray(let branch): branch.repo
        }
    }

    var stage: PullRequest.Stage? {
        if case .pullRequest(let pullRequest) = self { pullRequest.stage } else { nil }
    }

    var changed: Date {
        switch self {
        case .pullRequest(let pullRequest): pullRequest.updated
        case .stray(let branch): branch.committed
        }
    }

    var searchText: String {
        switch self {
        case .pullRequest(let pullRequest):
            "\(pullRequest.title) \(pullRequest.repo) #\(pullRequest.number) \(pullRequest.reason)"
        case .stray(let branch): "\(branch.name) \(branch.repo)"
        }
    }
}

enum Grouping: String, CaseIterable {
    case status, repository

    static let key = "rex-extensions.pending.grouping"
    static var saved: Grouping {
        UserDefaults.standard.string(forKey: key).flatMap(Grouping.init) ?? .status
    }
}

struct ItemSection: Identifiable {
    let id: String
    let title: String
    let items: [Item]
}

/// A line of the list: a section title, which folds its section, or an item.
enum Row: Identifiable {
    case title(ItemSection, collapsed: Bool)
    case item(Item, section: String)

    var id: String {
        switch self {
        case .title(let section, _): "section:\(section.id)"
        case .item(let item, _): item.id
        }
    }

    var sectionID: String {
        switch self {
        case .title(let section, _): section.id
        case .item(_, let section): section
        }
    }
}

private let collapsedKey = "rex-extensions.pending.collapsed"

private func savedCollapsed() -> Set<String> {
    Set(UserDefaults.standard.stringArray(forKey: collapsedKey) ?? [])
}

@MainActor @Observable
final class PendingModel {
    private(set) var pullRequests: Loadable<[PullRequest]> = .loading
    private(set) var strays: Loadable<[StrayBranch]> = .loading
    private(set) var refreshing = false
    private(set) var fetchedAt: Date?
    var selection = 0
    var query = "" {
        didSet { selection = 0 }
    }
    @ObservationIgnored var onDone: () -> Void = {}

    var grouping = Grouping.saved {
        didSet { UserDefaults.standard.set(grouping.rawValue, forKey: Grouping.key) }
    }

    private(set) var collapsed = savedCollapsed() {
        didSet { UserDefaults.standard.set(collapsed.sorted(), forKey: collapsedKey) }
    }

    var isFiltering: Bool { query.contains { !$0.isWhitespace } }

    var hasNoMatch: Bool {
        isFiltering && rows.isEmpty && pullRequests.value != nil && strays.value != nil
    }

    /// The loaded items that match `query`, grouped by merge status or by repository.
    var sections: [ItemSection] {
        guard isFiltering else { return groupedSections }
        return groupedSections.compactMap { section in
            let items = section.items.enumerated()
                .compactMap { index, item in
                    Fuzzy.score(query, in: item.searchText).map {
                        (score: $0, index: index, item: item)
                    }
                }
                .sorted { ($0.score, $0.index) < ($1.score, $1.index) }
                .map(\.item)
            return items.isEmpty
                ? nil : ItemSection(id: section.id, title: section.title, items: items)
        }
    }

    /// Lists the most recent change first, both for items and for repositories.
    private var groupedSections: [ItemSection] {
        let items =
            ((pullRequests.value ?? []).map(Item.pullRequest)
            + (strays.value ?? []).map(Item.stray))
            .sorted { $0.changed > $1.changed }
        switch grouping {
        case .status:
            let stages = PullRequest.Stage.allCases.map { stage in
                ItemSection(
                    id: "stage-\(stage)", title: stage.title,
                    items: items.filter { $0.stage == stage })
            }
            let branches = ItemSection(
                id: "strays", title: "Stray branches", items: items.filter { $0.stage == nil })
            return (stages + [branches]).filter { !$0.items.isEmpty }
        case .repository:
            return Dictionary(grouping: items, by: \.repo)
                .sorted { $0.value[0].changed > $1.value[0].changed }
                .map { repo, items in ItemSection(id: "repo-\(repo)", title: repo, items: items) }
        }
    }

    var rows: [Row] {
        sections.flatMap { section in
            let folded = collapsed.contains(section.id) && !isFiltering
            let items = folded ? [] : section.items.map { Row.item($0, section: section.id) }
            return [Row.title(section, collapsed: folded)] + items
        }
    }

    var selectedRow: Row? {
        let rows = rows
        return rows.indices.contains(selection) ? rows[selection] : nil
    }

    func refresh(path: String) {
        guard !refreshing else { return }
        refreshing = true
        Task {
            let github: GitHub
            do {
                github = try await Task.detached { try GitHub(path: path) }.value
            } catch {
                pullRequests = .failed(error.localizedDescription)
                strays = .failed(error.localizedDescription)
                refreshing = false
                return
            }
            async let openPullRequests = load { try await github.openPullRequests() }
            async let strayBranches = load { try await github.strayBranches() }
            let loadedPullRequests = await openPullRequests
            keepingSelection { pullRequests = loadedPullRequests }
            let loadedStrays = await strayBranches
            keepingSelection { strays = loadedStrays }
            fetchedAt = Date()
            refreshing = false
        }
    }

    func move(by delta: Int) {
        let count = rows.count
        guard count > 0 else { return }
        selection = (selection + delta + count) % count
    }

    func toggleGrouping() {
        keepingSelection { grouping = grouping == .status ? .repository : .status }
    }

    /// Opens the selected item on GitHub, or folds the selected section.
    func activate(_ row: Row? = nil) {
        switch row ?? selectedRow {
        case .title(let section, _): toggle(section.id)
        case .item(let item, _): open(item)
        case nil: break
        }
    }

    func open(_ item: Item) {
        NSWorkspace.shared.open(item.url)
        onDone()
    }

    func toggle(_ sectionID: String) {
        if collapsed.contains(sectionID) { expand(sectionID) } else { collapse(sectionID) }
    }

    func collapseSelected() {
        if let section = selectedRow?.sectionID { collapse(section) }
    }

    func expandSelected() {
        if let section = selectedRow?.sectionID { expand(section) }
    }

    /// Moves the selection to the section title, because the selected item is no longer listed.
    private func collapse(_ sectionID: String) {
        collapsed.insert(sectionID)
        selection = rows.firstIndex { $0.id == "section:\(sectionID)" } ?? 0
    }

    private func expand(_ sectionID: String) {
        keepingSelection { collapsed.remove(sectionID) }
    }

    /// Keeps the selection on the same row when a refresh or a new grouping reorders the list.
    private func keepingSelection(_ change: () -> Void) {
        let selected = selectedRow?.id
        change()
        let rows = rows
        selection = rows.firstIndex { $0.id == selected } ?? min(selection, max(rows.count - 1, 0))
    }
}

private func load<V: Sendable>(_ work: @Sendable () async throws -> V) async -> Loadable<V> {
    do { return .loaded(try await work()) } catch { return .failed(error.localizedDescription) }
}
