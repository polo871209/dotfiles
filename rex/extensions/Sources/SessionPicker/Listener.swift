import Foundation

final class Listener: Sendable {
    private let source: DispatchSourceRead

    init?(path: String, handle: @escaping @Sendable (Data) -> String) {
        let server = socket(AF_UNIX, SOCK_STREAM, 0)
        guard server >= 0 else { return nil }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        unlink(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, chmod(path, 0o600) == 0, listen(server, 4) == 0 else {
            close(server)
            return nil
        }
        source = DispatchSource.makeReadSource(
            fileDescriptor: server, queue: DispatchQueue(label: "rex-session-picker.listener"))
        source.setEventHandler {
            let connection = accept(server, nil, nil)
            guard connection >= 0 else { return }
            defer { close(connection) }
            var timeout = timeval(tv_sec: 1, tv_usec: 0)
            setsockopt(
                connection, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)
            )
            let reply = Array((handle(Self.readLine(connection)) + "\n").utf8)
            _ = reply.withUnsafeBytes { write(connection, $0.baseAddress, $0.count) }
        }
        source.resume()
    }

    private static func readLine(_ connection: Int32) -> Data {
        var line = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while line.count < 65536 {
            let count = read(connection, &buffer, buffer.count)
            guard count > 0 else { break }
            line.append(contentsOf: buffer[..<count])
            if buffer[..<count].contains(UInt8(ascii: "\n")) { break }
        }
        return line
    }
}
