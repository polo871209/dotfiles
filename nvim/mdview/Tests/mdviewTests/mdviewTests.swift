import Foundation
import Testing
@testable import mdview

// These pin the security and scroll invariants that the page code relies on.

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

        // Same content first: it must not report, so the next value is "two".
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
}
