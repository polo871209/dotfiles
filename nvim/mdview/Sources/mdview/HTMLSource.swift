enum HTMLSource {
    /// Adds `data-mdview-line="N"` to every start tag, where N is the 1-based source line of its `<`.
    /// Comments, declarations, end tags, and the contents of raw text elements such as `<script>` stay unchanged.
    static func annotatingLines(_ html: String) -> String {
        var scanner = Scanner(bytes: Array(html.utf8))
        while scanner.index < scanner.bytes.count {
            scanner.step()
        }
        scanner.out += scanner.bytes[scanner.copied...]
        return String(bytes: scanner.out, encoding: .utf8) ?? html
    }

    private struct Scanner {
        let bytes: [UInt8]
        var out: [UInt8] = []
        var line = 1
        var index = 0
        var copied = 0

        mutating func step() {
            guard bytes[index] == lessThan, index + 1 < bytes.count else { return move(to: index + 1) }
            let next = bytes[index + 1]
            if bytes[index...].starts(with: commentStart) {
                move(to: (find(commentEnd, from: index + commentStart.count) ?? bytes.count) + commentEnd.count)
            } else if isLetter(next) {
                startTag()
            } else if next == bang || next == question || next == slash {
                move(to: (find([greaterThan], from: index) ?? bytes.count) + 1)
            } else {
                move(to: index + 1)
            }
        }

        private mutating func startTag() {
            var nameEnd = index + 1
            while nameEnd < bytes.count, isNameCharacter(bytes[nameEnd]) { nameEnd += 1 }
            let name = bytes[index + 1..<nameEnd].map(lowercased)
            out += bytes[copied..<nameEnd]
            out += Array(" data-mdview-line=\"\(line)\"".utf8)
            copied = nameEnd

            var tagEnd = nameEnd
            var quote: UInt8?
            while tagEnd < bytes.count {
                let byte = bytes[tagEnd]
                if let open = quote {
                    if byte == open { quote = nil }
                } else if byte == doubleQuote || byte == singleQuote {
                    quote = byte
                } else if byte == greaterThan {
                    break
                }
                tagEnd += 1
            }
            let selfClosing = tagEnd < bytes.count && bytes[tagEnd - 1] == slash
            move(to: tagEnd + 1)
            if !selfClosing, rawTextElements.contains(name) {
                move(to: find(Array("</".utf8) + name, from: index, ignoringCase: true) ?? bytes.count)
            }
        }

        private mutating func move(to end: Int) {
            let end = min(end, bytes.count)
            line += bytes[index..<end].count { $0 == newline }
            index = end
        }

        private func find(_ marker: [UInt8], from start: Int, ignoringCase: Bool = false) -> Int? {
            var position = start
            while position + marker.count <= bytes.count {
                let candidate = bytes[position..<position + marker.count]
                if ignoringCase ? candidate.map(lowercased).elementsEqual(marker) : candidate.elementsEqual(marker) {
                    return position
                }
                position += 1
            }
            return nil
        }
    }

    private static let rawTextElements: Set<[UInt8]> = Set(
        ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"].map { Array($0.utf8) }
    )
    private static let commentStart = Array("<!--".utf8)
    private static let commentEnd = Array("-->".utf8)
    private static let newline = UInt8(ascii: "\n")
    private static let lessThan = UInt8(ascii: "<")
    private static let greaterThan = UInt8(ascii: ">")
    private static let slash = UInt8(ascii: "/")
    private static let bang = UInt8(ascii: "!")
    private static let question = UInt8(ascii: "?")
    private static let doubleQuote = UInt8(ascii: "\"")
    private static let singleQuote = UInt8(ascii: "'")

    private static func isLetter(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte | 0x20)
    }

    private static func isNameCharacter(_ byte: UInt8) -> Bool {
        isLetter(byte) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) || byte == UInt8(ascii: "-")
            || byte == UInt8(ascii: ":") || byte == UInt8(ascii: "_")
    }

    private static func lowercased(_ byte: UInt8) -> UInt8 {
        isLetter(byte) ? byte | 0x20 : byte
    }
}
