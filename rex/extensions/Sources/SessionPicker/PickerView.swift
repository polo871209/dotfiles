import RexKit
import SwiftUI

struct PickerView: View {
    @Bindable var model: PickerModel
    let theme: Theme
    @FocusState private var searchFocused: Bool

    var body: some View {
        let rows = model.visible
        let agentStates = model.agentStates
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.muted)
                TextField(
                    "", text: $model.query,
                    prompt: Text("Switch session or open directory").foregroundStyle(theme.muted)
                )
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .foregroundStyle(theme.foreground)
                .focused($searchFocused)
                if model.busy { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            theme.muted.opacity(0.25).frame(height: 1)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 1) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            RowView(
                                row: row, theme: theme, selected: index == model.selection,
                                filtering: model.isFiltering,
                                expanded: row.sessionID.map(model.expanded.contains) == true,
                                agentStates: row.sessionID.flatMap { agentStates[$0] } ?? []
                            )
                            .id(row.id)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                model.selection = index
                                model.choose()
                            }
                        }
                    }
                    .padding(6)
                }
                .scrollIndicators(.never)
                .onChange(of: model.selection) { _, index in
                    if rows.indices.contains(index) { proxy.scrollTo(rows[index].id) }
                }
            }
            theme.muted.opacity(0.25).frame(height: 1)
            HStack(spacing: 14) {
                if let error = model.error {
                    Text(error).foregroundStyle(theme.red).lineLimit(1).truncationMode(.middle)
                } else if model.loaded {
                    Text("\(rows.count) of \(model.listed.count)")
                }
                Spacer()
                Text("→ ← agents")
                Text(model.allExpanded ? "⇥ hide all" : "⇥ show all")
                Text("↩ open")
                Text("⌃X kill session")
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
}

private struct RowView: View {
    let row: Row
    let theme: Theme
    let selected: Bool
    let filtering: Bool
    let expanded: Bool
    let agentStates: [String]

    var body: some View {
        HStack(spacing: 8) {
            switch row.kind {
            case .session:
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.muted)
                    .opacity(agentStates.isEmpty ? 0 : 1)
                    .frame(width: 16)
                Text(row.label).foregroundStyle(theme.foreground)
                if !expanded {
                    HStack(spacing: 5) {
                        ForEach(Array(agentStates.enumerated()), id: \.offset) { _, state in
                            StatusMark(state: state, theme: theme)
                        }
                    }
                    .padding(.leading, 4)
                }
            case .dir:
                Image(systemName: "folder").font(.system(size: 11)).foregroundStyle(theme.muted)
                    .frame(width: 16)
                Text(row.label).foregroundStyle(theme.muted)
            case .agent:
                StatusMark(state: row.state, theme: theme).frame(width: 16)
                if let title = row.detail, !title.isEmpty {
                    Text(title).foregroundStyle(theme.foreground)
                    Text(row.label).font(.system(size: 11)).foregroundStyle(theme.muted)
                } else {
                    Text(row.label).foregroundStyle(theme.foreground)
                }
            }
            Spacer(minLength: 8)
            if row.isCurrent {
                Text("current").font(.system(size: 11)).foregroundStyle(theme.muted)
            } else if filtering, let context = row.context {
                Text(context).font(.system(size: 11)).foregroundStyle(theme.muted)
            }
        }
        .font(.system(size: 13))
        .lineLimit(1)
        .padding(.leading, row.kind == .agent && !filtering ? 34 : 10)
        .padding(.trailing, 10)
        .padding(.vertical, 6)
        .background(selected ? theme.selection : .clear, in: .rect(cornerRadius: 7))
    }
}

private struct StatusMark: View {
    let state: String?
    let theme: Theme

    var body: some View {
        switch state {
        case "working":
            Image(systemName: "circle.fill").font(.system(size: 7)).foregroundStyle(theme.yellow)
        case "blocked":
            Image(systemName: "diamond.fill").font(.system(size: 8)).foregroundStyle(theme.red)
        case "done":
            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(
                theme.green)
        case "error":
            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(
                theme.red)
        default: Image(systemName: "circle").font(.system(size: 7)).foregroundStyle(theme.muted)
        }
    }
}
