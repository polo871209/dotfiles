import Foundation

public struct ProcessFailure: Error {
    public let stderr: String
}

/// Runs `command` with `path` as PATH, because Rex starts from launchd with a bare PATH.
public func run(_ command: [String], path: String) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = command
    process.environment = ProcessInfo.processInfo.environment.merging(["PATH": path]) { $1 }
    let output = Pipe()
    let errors = Pipe()
    process.standardOutput = output
    process.standardError = errors
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let message = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw ProcessFailure(stderr: String(bytes: message, encoding: .utf8) ?? "")
    }
    return data
}
