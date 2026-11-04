import Foundation
import RexKit

struct RexError: LocalizedError {
    let errorDescription: String?
}

/// Runs the `rex` CLI with `path` as PATH.
struct Rex: Sendable {
    let client: String
    let current: String
    let rowsScript: String
    let path: String

    func rows() throws -> [Row] {
        try JSONDecoder().decode(RowList.self, from: run(["do", rowsScript, "current=\(current)"]))
            .rows
    }

    func open(_ row: Row) throws {
        switch row.kind {
        case .dir:
            _ = try run([
                "-C", client, "do", "session_open", "dir=\(row.dir ?? "")", "from=\(current)",
            ])
        case .session:
            _ = try run([
                "-C", client, "do", "session_switch", "session_id=\(row.sessionID ?? "")",
                "from=\(current)",
            ])
        case .agent:
            let session = row.sessionID ?? ""
            _ = try run([
                "-C", client, "do", "-s", session, "session_switch", "session_id=\(session)",
                "block_id=\(row.blockID ?? "")", "from=\(current)",
            ])
        }
    }

    func kill(session: String) throws {
        _ = try run(["kill", session])
    }

    private func run(_ arguments: [String]) throws -> Data {
        do {
            return try RexKit.run(["rex"] + arguments, path: path)
        } catch let failure as ProcessFailure {
            let text = failure.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            throw RexError(
                errorDescription: text.isEmpty ? "rex \(arguments.first ?? "") failed" : text)
        }
    }
}
