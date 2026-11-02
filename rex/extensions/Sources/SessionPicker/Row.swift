struct Row: Decodable, Identifiable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case session, agent, dir
    }

    let kind: Kind
    let label: String
    var sessionID: String?
    var blockID: String?
    var dir: String?
    var detail: String?
    var state: String?
    var context: String?
    var current: Bool?

    private enum CodingKeys: String, CodingKey {
        case kind, label, dir, detail, state, context, current
        case sessionID = "session_id"
        case blockID = "block_id"
    }

    var id: String {
        [kind.rawValue, sessionID ?? "", blockID ?? "", dir ?? ""].joined(separator: "|")
    }
    var searchText: String { [label, detail, context].compactMap(\.self).joined(separator: " ") }
    var isCurrent: Bool { current == true }
}

struct RowList: Decodable {
    let rows: [Row]

    // rex.json encodes an empty Lua table as an object, so `{"rows":{}}` means no rows.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rows = (try? container.decode([Row].self, forKey: .rows)) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case rows
    }
}
