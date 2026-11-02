import Foundation

struct RexError: LocalizedError {
    let errorDescription: String?
}

/// Runs the `rex` CLI with `path` as PATH, because Rex starts from launchd with a bare PATH.
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
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["rex"] + arguments
        process.environment = ProcessInfo.processInfo.environment.merging(["PATH": path]) { $1 }
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let message = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let text = (String(bytes: message, encoding: .utf8) ?? "").trimmingCharacters(
                in: .whitespacesAndNewlines)
            throw RexError(
                errorDescription: text.isEmpty ? "rex \(arguments.first ?? "") failed" : text)
        }
        return data
    }
}
