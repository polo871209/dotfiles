import Foundation

struct Message: Decodable, Sendable {
    let path: String
    let text: String
    var top: Int
}

struct Choose: Decodable, Sendable {
    struct Listener: Decodable, Sendable {
        let sock: String
        let window: String
        let label: String
    }

    let choose: [Listener]
}

struct Sent: Decodable, Sendable {
    let sent: Bool
    let info: String
}

struct Open: Encodable {
    let open: String
    let anchor: String?
}

struct Scroll: Encodable {
    let path: String
    let top: Int
}

struct Comment: Encodable {
    let comment: String
    let path: String
    let sline: Int
    let eline: Int
    let target: String?
}

func toNvim(_ message: some Encodable) {
    if let line = try? JSONEncoder().encode(message) {
        FileHandle.standardOutput.write(line + Data("\n".utf8))
    }
}
