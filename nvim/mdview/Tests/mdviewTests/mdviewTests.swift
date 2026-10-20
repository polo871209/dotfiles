import Foundation
import Testing
@testable import mdview

@Suite struct MarkdownTests {
    @Test func tagsBlocksWithSourceLines() {
        #expect(Markdown.html("# Title\n\ntext\n").contains(#"<p data-sourcepos="3:1-3:4">"#))
    }

    @Test func keepsRawHTML() {
        #expect(Markdown.html("<details><summary>s</summary>x</details>\n").contains("<details>"))
    }

    @Test func escapesScriptTags() {
        #expect(!Markdown.html("<script>alert(1)</script>\n").contains("<script>"))
    }

    @Test func rendersGitHubExtensions() {
        let html = Markdown.html("| a |\n|---|\n| 1 |\n\n- [x] done\n\n~~gone~~\n")
        #expect(html.contains("<table"))
        #expect(html.contains(#"type="checkbox""#))
        #expect(html.contains("<del>"))
    }
}

@Suite struct HTMLSourceTests {
    @Test func tagsStartTagsWithTheirSourceLine() {
        let html = "<!doctype html>\n<p class=\"a>b\"\n  id=x>text</p>\n<br/><IMG src=y>\n"
        #expect(HTMLSource.annotatingLines(html) == """
            <!doctype html>
            <p data-mdview-line="2" class="a>b"
              id=x>text</p>
            <br data-mdview-line="4"/><IMG data-mdview-line="4" src=y>

            """)
    }

    @Test func skipsCommentsAndRawText() {
        let html = "<!-- <p>\n -->\n<script>if (a<b) x = '<div>'\n</SCRIPT><i>\n"
        #expect(HTMLSource.annotatingLines(html) == """
            <!-- <p>
             -->
            <script data-mdview-line="3">if (a<b) x = '<div>'
            </SCRIPT><i data-mdview-line="4">

            """)
    }
}

@MainActor @Suite struct FileWatcherTests {
    @Test(.timeLimit(.minutes(1))) func reportsInPlaceAndAtomicWrites() async throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appending(path: "a.md")
        try "one".write(to: file, atomically: false, encoding: .utf8)
        let (stream, continuation) = AsyncStream.makeStream(of: String.self)
        let watcher = FileWatcher(path: file.path) { continuation.yield($0) }
        var texts = stream.makeAsyncIterator()

        try "one".write(to: file, atomically: false, encoding: .utf8)
        try await Task.sleep(for: .milliseconds(200))
        try "two".write(to: file, atomically: false, encoding: .utf8)
        #expect(await texts.next() == "two")
        try "three".write(to: file, atomically: true, encoding: .utf8)
        #expect(await texts.next() == "three")
        withExtendedLifetime(watcher) {}
    }
}

@Suite struct AssetsTests {
    @Test func servesBundledFiles() {
        #expect(Assets.resolve(URL(string: "mdview://app/app.js")!) != nil)
    }

    @Test func refusesPathTraversal() {
        #expect(Assets.resolve(URL(string: "mdview://app/../../Package.swift")!) == nil)
    }

    @Test func servesOnlyImagesFromDisk() {
        #expect(Assets.resolve(URL(string: "mdview://file/tmp/a.png")!) != nil)
        #expect(Assets.resolve(URL(string: "mdview://file/Users/me/.ssh/id_ed25519")!) == nil)
        #expect(Assets.resolve(URL(string: "mdview://file/Users/me/notes.md")!) == nil)
    }

    @Test func servesAnHTMLDocumentOnlyTheFilesUnderItsDirectory() {
        let site = URL(filePath: "/tmp/site")
        #expect(Assets.resolve(URL(string: "mdview://file/tmp/site/css/style.css")!, under: site) != nil)
        #expect(Assets.resolve(URL(string: "mdview://file/tmp/style.css")!, under: site) == nil)
        #expect(Assets.resolve(URL(string: "mdview://file/tmp/site/../secret.txt")!, under: site) == nil)
    }

    @Test func blocksScriptsFromRawHTML() throws {
        let page = try String(contentsOf: #require(Assets.resolve(URL(string: "mdview://app/index.html")!)), encoding: .utf8)
        let policy = try #require(page.firstMatch(of: /http-equiv="Content-Security-Policy" content="([^"]*)"/)).1
        var directives: [Substring: [Substring]] = [:]
        for directive in policy.split(separator: ";") {
            let words = directive.split(separator: " ")
            if let name = words.first { directives[name] = Array(words.dropFirst()) }
        }
        #expect(directives["default-src"] == ["'none'"])
        #expect(directives["script-src"] == ["mdview:"])
        #expect(directives["connect-src"] == nil)
    }
}
