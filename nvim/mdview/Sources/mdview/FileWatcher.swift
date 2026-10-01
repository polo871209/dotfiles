import Foundation

/// Calls `changed` with the new text when the content of the file at `path` changes on disk.
/// Editors and agents either write in place or rename a temp file over the target, so this watches the file and its directory.
@MainActor
final class FileWatcher {
    let path: String
    private let changed: @MainActor (String) -> Void
    private var directory: DispatchSourceFileSystemObject?
    private var file: DispatchSourceFileSystemObject?
    private var debounce: Task<Void, Never>?
    /// Last content read from disk. A touch, a chmod, or another file in the directory reads the same text and reports nothing.
    private var text: String?

    init(path: String, changed: @escaping @MainActor (String) -> Void) {
        self.path = path
        self.changed = changed
        text = read()
        directory = watch(URL(filePath: path).deletingLastPathComponent().path, [.write])
        file = watch(path, [.write, .extend, .delete, .rename])
    }

    isolated deinit {
        directory?.cancel()
        file?.cancel()
        debounce?.cancel()
    }

    private func read() -> String? {
        FileManager.default.contents(atPath: path).map { String(decoding: $0, as: UTF8.self) }
    }

    private func watch(_ path: String, _ events: DispatchSource.FileSystemEvent) -> DispatchSourceFileSystemObject? {
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: events, queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.fire() } }
        source.setCancelHandler { close(fd) }
        source.resume()
        return source
    }

    private func fire() {
        // After a rename or delete the old descriptor points at a dead inode, so reopen the path on every event.
        file?.cancel()
        file = watch(path, [.write, .extend, .delete, .rename])
        // A truncate and the write after it arrive as two events. Reading after the first one would flash an empty page.
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(50))
            guard !Task.isCancelled, let self, let new = read(), new != text else { return }
            text = new
            changed(new)
        }
    }
}
