import RexKit
import Testing

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
