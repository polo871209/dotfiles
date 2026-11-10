/// Matches each whitespace-separated term of `query` as a subsequence of `text`.
/// Returns nil if a term does not match, and a lower score for a tighter match.
public enum Fuzzy {
    public static func score(_ query: String, in text: String) -> Int? {
        let haystack = Array(text.lowercased())
        var total = 0
        for term in query.lowercased().split(whereSeparator: \.isWhitespace) {
            guard let termScore = score(term: Array(term), in: haystack) else { return nil }
            total += termScore
        }
        return total
    }

    private static func score(term: [Character], in haystack: [Character]) -> Int? {
        var best: Int?
        for start in haystack.indices where haystack[start] == term[0] {
            guard let span = span(of: term, in: haystack, from: start) else { break }
            let atWordStart = start == 0 || !haystack[start - 1].isLetter
            let candidate = span * 2 + (atWordStart ? 0 : 1)
            best = min(best ?? candidate, candidate)
        }
        return best
    }

    private static func span(of term: [Character], in text: [Character], from start: Int) -> Int? {
        var position = start
        for character in term.dropFirst() {
            guard let next = text[(position + 1)...].firstIndex(of: character) else {
                return nil
            }
            position = next
        }
        return position - start + 1 - term.count
    }
}
