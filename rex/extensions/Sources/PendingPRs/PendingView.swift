import RexKit
import SwiftUI

struct PendingView: View {
    @Bindable var model: PendingModel
    let theme: Theme
    @FocusState private var searchFocused: Bool

    var body: some View {
        let selectedID = model.selectedRow?.id
        VStack(spacing: 0) {
            header
            divider
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        rows(selectedID: selectedID)
                    }
                    .padding(6)
                }
                .scrollIndicators(.never)
                .onChange(of: selectedID) { _, id in
                    if let id { proxy.scrollTo(id) }
                }
            }
            divider
            HStack(spacing: 14) {
                Spacer()
                Text(model.grouping == .status ? "⇥ by repository" : "⇥ by status")
                Text("← → fold")
                Text("↩ open")
                Text("⌘R refresh")
                Text("esc close")
            }
            .font(.system(size: 11))
            .foregroundStyle(theme.muted)
            .padding(.horizontal, 16)
            .padding(.vertical, 7)
        }
        .background(theme.background, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(theme.muted.opacity(0.35)))
        .shadow(color: .black.opacity(0.35), radius: 24, y: 8)
        .onAppear { searchFocused = true }
    }

    private var divider: some View { theme.muted.opacity(0.25).frame(height: 1) }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(theme.muted)
            TextField(
                "", text: $model.query,
                prompt: Text("Search pending PRs and branches").foregroundStyle(theme.muted)
            )
            .textFieldStyle(.plain)
            .font(.system(size: 15))
            .foregroundStyle(theme.foreground)
            .focused($searchFocused)
            HStack(spacing: 4) {
                Text("by \(model.grouping.rawValue)")
                Image(systemName: "chevron.up.chevron.down").font(
                    .system(size: 8, weight: .semibold))
            }
            .font(.system(size: 12))
            .foregroundStyle(theme.muted)
            .contentShape(Rectangle())
            .onTapGesture { model.toggleGrouping() }
            if model.refreshing {
                ProgressView().controlSize(.small)
            } else if let fetchedAt = model.fetchedAt {
                Text("updated \(Text(fetchedAt, style: .relative)) ago")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.muted)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    @ViewBuilder
    private func rowView(_ row: Row, selected: Bool, showsRepo: Bool) -> some View {
        switch row {
        case .title(let section, let collapsed):
            SectionTitle(
                title: section.title, count: section.items.count, collapsed: collapsed,
                selected: selected, theme: theme)
        case .item(.pullRequest(let pullRequest), _):
            PullRequestRow(
                pullRequest: pullRequest, theme: theme, selected: selected, showsRepo: showsRepo)
        case .item(.stray(let branch), _):
            StrayRow(branch: branch, theme: theme, selected: selected, showsRepo: showsRepo)
        }
    }

    @ViewBuilder
    private func rows(selectedID: String?) -> some View {
        let byRepository = model.grouping == .repository
        switch model.pullRequests {
        case .loading: Placeholder(text: "Loading pull requests…", theme: theme, busy: true)
        case .failed(let message): Placeholder(text: message, theme: theme, color: theme.red)
        case .loaded: EmptyView()
        }
        ForEach(model.rows) { row in
            rowView(row, selected: row.id == selectedID, showsRepo: !byRepository)
                .id(row.id)
                .contentShape(Rectangle())
                .onTapGesture { model.activate(row) }
        }
        switch model.strays {
        case .loading: Placeholder(text: "Scanning branches…", theme: theme, busy: true)
        case .failed(let message): Placeholder(text: message, theme: theme, color: theme.red)
        case .loaded: EmptyView()
        }
        if model.pullRequests.value?.isEmpty == true, model.strays.value?.isEmpty == true {
            Placeholder(text: "Nothing pending", theme: theme)
        } else if model.hasNoMatch {
            Placeholder(text: "No match for “\(model.query)”", theme: theme)
        }
    }
}

extension PullRequest.Stage {
    var title: String {
        switch self {
        case .ready: "Ready to merge"
        case .action: "Needs you"
        case .waiting: "Waiting on others"
        case .draft: "Drafts"
        }
    }

    func color(_ theme: Theme) -> Color {
        switch self {
        case .ready: theme.green
        case .action: theme.red
        case .waiting: theme.yellow
        case .draft: theme.muted
        }
    }
}

private struct SectionTitle: View {
    let title: String
    let count: Int
    let collapsed: Bool
    let selected: Bool
    let theme: Theme

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                .font(.system(size: 8, weight: .bold))
                .frame(width: 10)
            Text(title.uppercased()).tracking(0.6)
            Text("\(count)").monospacedDigit()
            Spacer()
        }
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundStyle(selected ? theme.foreground : theme.muted)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(selected ? theme.selection : .clear, in: .rect(cornerRadius: 7))
        .padding(.top, 6)
    }
}

private struct Placeholder: View {
    let text: String
    let theme: Theme
    var busy = false
    var color: Color?

    var body: some View {
        HStack(spacing: 8) {
            if busy { ProgressView().controlSize(.mini) }
            Text(text).foregroundStyle(color ?? theme.muted).lineLimit(2)
        }
        .font(.system(size: 12))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }
}

private struct PullRequestRow: View {
    let pullRequest: PullRequest
    let theme: Theme
    let selected: Bool
    let showsRepo: Bool

    var body: some View {
        let color = pullRequest.stage.color(theme)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().fill(color).frame(width: 7, height: 7).alignmentGuide(.firstTextBaseline) {
                $0[.bottom] - 1
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(pullRequest.title).foregroundStyle(theme.foreground)
                Text(
                    showsRepo
                        ? "\(pullRequest.repo) #\(pullRequest.number)" : "#\(pullRequest.number)"
                )
                .font(.system(size: 11))
                .foregroundStyle(theme.muted)
                if selected, !pullRequest.details.isEmpty {
                    Text(pullRequest.details.joined(separator: " · "))
                        .font(.system(size: 11))
                        .foregroundStyle(theme.muted)
                        .lineLimit(3)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 12)
            Text(pullRequest.reason).font(.system(size: 11.5)).foregroundStyle(color)
        }
        .font(.system(size: 13))
        .lineLimit(1)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(selected ? theme.selection : .clear, in: .rect(cornerRadius: 7))
    }
}

private struct StrayRow: View {
    let branch: StrayBranch
    let theme: Theme
    let selected: Bool
    let showsRepo: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 9))
                .foregroundStyle(theme.muted)
                .frame(width: 7)
            VStack(alignment: .leading, spacing: 3) {
                Text(branch.name).foregroundStyle(theme.foreground)
                Text((showsRepo ? "\(branch.repo) · " : "") + "last commit \(committedDay)")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.muted)
            }
            Spacer(minLength: 12)
            Text(status).font(.system(size: 11.5)).foregroundStyle(theme.muted)
        }
        .font(.system(size: 13))
        .lineLimit(1)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(selected ? theme.selection : .clear, in: .rect(cornerRadius: 7))
    }

    private var committedDay: String {
        branch.committed.formatted(.iso8601.year().month().day())
    }

    private var status: String {
        let numbers = branch.pullRequests.map { "#\($0)" }.joined(separator: " ")
        switch branch.kind {
        case .merged: return "merged \(numbers)"
        case .closed: return "closed \(numbers)"
        case .never: return "no PR"
        }
    }
}
