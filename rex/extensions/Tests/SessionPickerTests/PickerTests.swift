import Foundation
import Testing

@testable import SessionPicker

@Test func matchesTermsInOrder() {
    #expect(Fuzzy.score("dtf", in: "~/dotfiles") != nil)
    #expect(Fuzzy.score("ftd", in: "~/dotfiles") == nil)
}

@Test func everyTermMustMatch() {
    #expect(Fuzzy.score("pi orch", in: "pi orchestrator ~/workspace/qashier-crew") != nil)
    #expect(Fuzzy.score("pi zzz", in: "pi orchestrator") == nil)
}

@Test func contiguousBeatsScattered() throws {
    let contiguous = try #require(Fuzzy.score("dot", in: "~/dotfiles"))
    let scattered = try #require(Fuzzy.score("dot", in: "~/d-o-t"))
    #expect(contiguous < scattered)
}

@Test func wordStartBeatsMidWord() throws {
    let wordStart = try #require(Fuzzy.score("crew", in: "~/workspace/crew"))
    let midWord = try #require(Fuzzy.score("crew", in: "~/screwdriver"))
    #expect(wordStart < midWord)
}

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
