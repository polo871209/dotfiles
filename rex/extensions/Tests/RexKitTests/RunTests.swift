import Foundation
import Testing

@testable import RexKit

@Test func returnsStandardOutput() throws {
    let output = try run(["sh", "-c", "printf %s \"$PATH\""], path: "/bin:/usr/bin")
    #expect(String(bytes: output, encoding: .utf8) == "/bin:/usr/bin")
}

@Test func failureCarriesStandardError() {
    #expect {
        try run(["sh", "-c", "echo oops >&2; exit 3"], path: "/bin:/usr/bin")
    } throws: { error in
        (error as? ProcessFailure)?.stderr == "oops\n"
    }
}
