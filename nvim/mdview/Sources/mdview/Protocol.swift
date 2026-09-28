import Foundation

// The wire format with nvim/lua/mdview.lua: one JSON object per line in each direction.
// stdin carries `Message`, stdout carries `Open`. EOF on stdin quits the viewer.

/// nvim to viewer: the buffer to render.
struct Message: Decodable, Sendable {
    let path: String
    let text: String
    /// 1-based cursor line. app.js scrolls to it only when it is off screen.
    let line: Int
}

/// Viewer to nvim: open this file, from a clicked link or from Back and Forward.
struct Open: Encodable {
    let open: String
    /// URL fragment. nvim reads `L42` as a line number, and app.js handles heading ids.
    let anchor: String?
}

func openInNvim(_ path: String, anchor: String? = nil) {
    if let line = try? JSONEncoder().encode(Open(open: path, anchor: anchor)) {
        FileHandle.standardOutput.write(line + Data("\n".utf8))
    }
}
