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
