import Foundation

struct Envelope<T: Decodable>: Decodable {
    struct Message: Decodable { let message: String }
    let data: T?
    let errors: [Message]?
    let message: String?
}

struct PageInfo: Decodable, Sendable {
    let hasNextPage: Bool
    let endCursor: String?
}

struct Login: Decodable, Sendable {
    let login: String
}

struct Nodes<Node: Decodable>: Decodable {
    let nodes: [Node]
}

struct Connection<Node: Decodable & Sendable>: Decodable, Sendable {
    let totalCount: Int
    let nodes: [Node]
}

struct SearchResult<Node: Decodable>: Decodable {
    struct Search: Decodable {
        let issueCount: Int
        let pageInfo: PageInfo
        let nodes: [Node]
    }
    let search: Search
}

struct ViewerLogin: Decodable {
    let viewer: Login
}

struct ViewerOrganizations: Decodable {
    struct Viewer: Decodable { let organizations: Nodes<Login> }
    let viewer: Viewer
}

struct OrganizationRepos: Decodable {
    struct Repo: Decodable { let nameWithOwner: String }
    struct Repositories: Decodable {
        let pageInfo: PageInfo
        let nodes: [Repo]
    }
    struct Organization: Decodable { let repositories: Repositories }
    let organization: Organization
}

struct OpenNode: Decodable {
    struct Repository: Decodable { let name: String }
    struct Reviewer: Decodable {
        let login: String?
        let name: String?
    }
    struct ReviewRequest: Decodable { let requestedReviewer: Reviewer? }
    struct Review: Decodable {
        let state: String
        let author: Login?
    }
    struct Rollup: Decodable { let contexts: Nodes<CheckContext> }
    struct Commit: Decodable { let statusCheckRollup: Rollup? }
    struct CommitNode: Decodable { let commit: Commit }

    let number: Int
    let title: String
    let url: URL
    let isDraft: Bool
    let updatedAt: Date
    let repository: Repository
    let mergeable: String
    let mergeStateStatus: String
    let reviewDecision: String?
    let reviewRequests: Nodes<ReviewRequest>
    let latestOpinionatedReviews: Nodes<Review>
    let commits: Nodes<CommitNode>
}

/// A CheckRun or a StatusContext, which GitHub reports in one list.
struct CheckContext: Decodable {
    let typename: String
    let name: String?
    let status: String?
    let conclusion: String?
    let context: String?
    let state: String?

    private enum CodingKeys: String, CodingKey {
        case typename = "__typename"
        case name, status, conclusion, context, state
    }
}

struct ClosedNode: Decodable {
    struct Repository: Decodable { let nameWithOwner: String }
    let headRefName: String
    let headRepository: Repository?
}

struct Branch: Sendable {
    let repo: String
    let name: String
    let committed: Date
    let headAuthoredByMe: Bool
}

struct RefNode: Decodable, Sendable {
    struct Author: Decodable, Sendable { let user: Login? }
    struct Target: Decodable, Sendable {
        let committedDate: Date
        let authors: Connection<Author>
    }
    struct Rule: Decodable, Sendable { let id: String }
    let name: String
    let branchProtectionRule: Rule?
    let target: Target
}

struct RefPage: Decodable, Sendable {
    let pageInfo: PageInfo
    let nodes: [RefNode]
}

struct RepositoryRefs: Decodable, Sendable {
    struct DefaultBranch: Decodable, Sendable { let name: String }
    let nameWithOwner: String
    let defaultBranchRef: DefaultBranch?
    let refs: RefPage
}

struct RepositoryPage: Decodable {
    struct Repository: Decodable { let refs: RefPage }
    let repository: Repository
}

struct HeadPullRequest: Decodable, Sendable {
    let number: Int
    let url: URL
    let state: String
    let author: Login?
}

struct BasePullRequest: Decodable, Sendable {
    let state: String
    let author: Login?
}

/// One alias of the classify query, which is either a head ref (`h0`) or a base PR list (`b0`).
struct BranchAlias: Decodable {
    struct Head: Decodable { let associatedPullRequests: Connection<HeadPullRequest> }
    let head: Head?
    let base: Connection<BasePullRequest>?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        head = try? container.decode(Head.self)
        base = try? container.decode(Connection<BasePullRequest>.self)
    }
}

struct BranchPullRequests: Decodable {
    let repository: [String: BranchAlias]
}
