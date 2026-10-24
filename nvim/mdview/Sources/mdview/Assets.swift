import Foundation
import Synchronization
import UniformTypeIdentifiers
import WebKit

final class DocumentRoot: Sendable {
    private let value = Mutex<URL?>(nil)

    var directory: URL? {
        get { value.withLock { $0 } }
        set { value.withLock { $0 = newValue } }
    }
}

struct Assets: URLSchemeHandler {
    var documentRoot: DocumentRoot?

    private static let imageTypes: Set<String> = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "heic", "ico", "bmp"]
    private static let root = Bundle.module.url(forResource: "Resources", withExtension: nil)!

    func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
        AsyncThrowingStream { continuation in
            do {
                guard let url = request.url, let file = Self.resolve(url, under: documentRoot?.directory) else {
                    throw URLError(.fileDoesNotExist)
                }
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

    static func resolve(_ url: URL, under directory: URL? = nil) -> URL? {
        let path = url.path(percentEncoded: false)
        switch url.host() {
        case "app":
            let file = root.appending(path: String(path.drop { $0 == "/" })).standardizedFileURL
            return file.path.hasPrefix(root.standardizedFileURL.path + "/") ? file : nil
        case "file":
            let file = URL(filePath: path).standardizedFileURL
            if imageTypes.contains(file.pathExtension.lowercased()) { return file }
            guard let directory else { return nil }
            return file.path.hasPrefix(directory.standardizedFileURL.path + "/") ? file : nil
        default:
            return nil
        }
    }
}
