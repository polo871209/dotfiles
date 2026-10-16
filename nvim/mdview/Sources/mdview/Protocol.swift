import Foundation

// The wire format with nvim/lua/mdview.lua: one JSON object per line in each direction.
// stdin carries `Message`, `Choose`, or `Sent`, stdout carries `Open`, `Scroll`, or `Comment`. EOF on stdin quits the viewer.
/// nvim to viewer: the buffer to render.
struct Message: Decodable, Sendable {
    let path: String
    let text: String
    /// 1-based line at the top of the nvim window. app.js puts it at the top of the page.
    var top: Int
}

/// nvim to viewer: two or more pi listeners run, and neither the last `Comment` nor an earlier choice for the buffer names a live one.
/// The viewer asks which one, then sends the `Comment` again with that `sock` as its target.
struct Choose: Decodable, Sendable {
    struct Listener: Decodable, Sendable {
        let sock: String
        /// tmux window index, the number on the tmux tab.
        let window: String
        /// tmux window name.
        let label: String
    }

    let choose: [Listener]
}

/// nvim to viewer: pi's answer to the last `Comment`.
struct Sent: Decodable, Sendable {
    let sent: Bool
    /// Where pi delivered the comment, or why it did not.
    let info: String
}

/// Viewer to nvim: open this file, from a clicked link or from Back and Forward.
struct Open: Encodable {
    let open: String
    /// URL fragment. nvim reads `L42` as a line number, and app.js handles heading ids.
    let anchor: String?
}

/// Viewer to nvim: the page scrolled, so nvim puts line `top` of `path` at the top of its window.
struct Scroll: Encodable {
    let path: String
    let top: Int
}

/// Viewer to nvim: send `comment` on source lines `sline` to `eline` of `path` to pi.
struct Comment: Encodable {
    let comment: String
    let path: String
    let sline: Int
    let eline: Int
    /// Socket of the pi listener that the user chose after a `Choose`.
    let target: String?
}

func toNvim(_ message: some Encodable) {
    if let line = try? JSONEncoder().encode(message) {
        FileHandle.standardOutput.write(line + Data("\n".utf8))
    }
}
