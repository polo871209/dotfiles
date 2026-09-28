import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves `mdview://app/<name>` from the bundled Resources and `mdview://file/<abs path>` from disk.
struct Assets: URLSchemeHandler {
    // Markdown can reach mdview://file, so the disk route serves images only, never text or keys.
    private static let imageTypes: Set<String> = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "heic", "ico", "bmp"]
    private static let root = Bundle.module.url(forResource: "Resources", withExtension: nil)!

    func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
        AsyncThrowingStream { continuation in
            do {
                guard let url = request.url, let file = Self.resolve(url) else { throw URLError(.fileDoesNotExist) }
                let data = try Data(contentsOf: file)
                let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                continuation.yield(.response(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8")))
                continuation.yield(.data(data))
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
    }

    static func resolve(_ url: URL) -> URL? {
        let path = url.path(percentEncoded: false)
        switch url.host() {
        case "app":
            let file = root.appending(path: String(path.drop { $0 == "/" })).standardizedFileURL
            return file.path.hasPrefix(root.standardizedFileURL.path + "/") ? file : nil
        case "file":
            let file = URL(filePath: path).standardizedFileURL
            return imageTypes.contains(file.pathExtension.lowercased()) ? file : nil
        default:
            return nil
        }
    }
}
