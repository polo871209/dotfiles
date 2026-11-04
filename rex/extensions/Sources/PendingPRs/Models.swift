import Foundation

struct GitHubError: LocalizedError {
    let errorDescription: String?
}

struct PullRequest: Identifiable, Sendable {
    enum Stage: Int, CaseIterable, Sendable {
        case ready, action, waiting, draft
    }

    let repo: String
    let number: Int
    let title: String
    let url: URL
    let stage: Stage
    let reason: String
    let details: [String]
    var id: URL { url }
}

struct StrayBranch: Identifiable, Sendable {
    enum Kind: Sendable {
        case merged, closed, never
    }

    let repo: String
    let name: String
    let committed: String
    let kind: Kind
    let pullRequests: [Int]
    let url: URL
    var id: String { "\(repo)\t\(name)" }
}
