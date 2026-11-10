import Foundation
import Testing

@testable import SessionPicker

@Test func rowsKeepTheirRexIDs() throws {
    let json =
        #"{"rows":[{"kind":"agent","label":"pi","session_id":"session:1","block_id":"block:2"}]}"#
    let row = try #require(try JSONDecoder().decode(RowList.self, from: Data(json.utf8)).rows.first)
    #expect(row.sessionID == "session:1")
    #expect(row.blockID == "block:2")
}

@Test func emptyRowsObjectDecodesAsNoRows() throws {
    let decoded = try JSONDecoder().decode(RowList.self, from: Data(#"{"rows":{}}"#.utf8))
    #expect(decoded.rows.isEmpty)
}
