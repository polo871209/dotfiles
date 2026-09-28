import cmark_gfm
import cmark_gfm_extensions
import Foundation

enum Markdown {
    // SOURCEPOS tags each block with data-sourcepos, which app.js uses to reveal the edited line.
    // UNSAFE keeps raw HTML such as <details> and <img width>. The page CSP blocks inline scripts.
    private static let options = CMARK_OPT_SOURCEPOS | CMARK_OPT_UNSAFE | CMARK_OPT_FOOTNOTES

    static func html(_ text: String) -> String {
        cmark_gfm_core_extensions_ensure_registered()
        guard let parser = cmark_parser_new(options) else { return "" }
        defer { cmark_parser_free(parser) }
        for name in ["table", "strikethrough", "autolink", "tagfilter", "tasklist"] {
            if let ext = cmark_find_syntax_extension(name) {
                cmark_parser_attach_syntax_extension(parser, ext)
            }
        }
        cmark_parser_feed(parser, text, text.utf8.count)
        guard let doc = cmark_parser_finish(parser) else { return "" }
        defer { cmark_node_free(doc) }
        guard let out = cmark_render_html(doc, options, cmark_parser_get_syntax_extensions(parser)) else { return "" }
        defer { free(out) }
        return String(cString: out)
    }
}
