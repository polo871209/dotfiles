import Foundation
import RexKit

private typealias Variables = [String: String?]

struct GitHub: Sendable {
    private let token: String

    init(path: String) throws {
        let output: Data
        do {
            output = try run(["gh", "auth", "token"], path: path)
        } catch let failure as ProcessFailure {
            throw GitHubError(errorDescription: "gh auth token: \(failure.stderr)")
        }
        let text = String(bytes: output, encoding: .utf8) ?? ""
        self.token = text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func openPullRequests() async throws -> [PullRequest] {
        let nodes: [OpenNode] = try await search(
            "is:pr is:open author:@me archived:false sort:updated-desc",
            fields: """
                number title url isDraft repository{name}
                mergeable mergeStateStatus reviewDecision
                reviewRequests(first:20){nodes{requestedReviewer{
                  ... on User{login} ... on Team{name}}}}
                latestOpinionatedReviews(first:20){nodes{state author{login}}}
                commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
                  __typename
                  ... on CheckRun{name status conclusion}
                  ... on StatusContext{context state}}}}}}}
                """)
        return nodes.map(\.pullRequest)
    }

    func strayBranches() async throws -> [StrayBranch] {
        async let viewerQuery: ViewerLogin = graphql("{viewer{login}}")
        async let closedQuery: [ClosedNode] = search(
            "is:pr is:closed author:@me archived:false",
            fields: "headRefName headRepository{nameWithOwner}")
        let repos = try await organizationRepos()
        let login = try await viewerQuery.viewer.login
        let branches = try await scanBranches(repos, login: login)
        let closedHeads = Set(
            try await closedQuery.map { pullRequest in
                "\(pullRequest.headRepository?.nameWithOwner ?? "")\t\(pullRequest.headRefName)"
            })
        let candidates = branches.filter {
            $0.headAuthoredByMe || closedHeads.contains("\($0.repo)\t\($0.name)")
        }
        return try await classify(candidates, login: login)
            .sorted { ($0.repo, $1.committed) < ($1.repo, $0.committed) }
    }

    private func graphql<T: Decodable>(_ query: String, _ vars: Variables = [:]) async throws -> T {
        var request = URLRequest(url: URL(string: "https://api.github.com/graphql")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "query": query, "variables": vars.mapValues { $0 ?? NSNull() as Any },
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        let envelope = try JSONDecoder().decode(Envelope<T>.self, from: data)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, envelope.errors == nil, let result = envelope.data else {
            let errors = envelope.errors?.map(\.message).joined(separator: "; ")
            throw GitHubError(
                errorDescription: "GitHub \(status): \(errors ?? envelope.message ?? "")")
        }
        return result
    }

    private func search<Node: Decodable>(_ query: String, fields: String) async throws -> [Node] {
        var nodes: [Node] = []
        var after: String?
        repeat {
            let page: SearchResult<Node> = try await graphql(
                """
                query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){
                  issueCount pageInfo{hasNextPage endCursor}
                  nodes{... on PullRequest{\(fields)}}}}
                """, ["q": query, "after": after])
            let total = page.search.issueCount
            guard total <= 1000 else {
                let message = "\(query) matches \(total) PRs, and GitHub search stops at 1000"
                throw GitHubError(errorDescription: message)
            }
            nodes += page.search.nodes
            after = page.search.pageInfo.hasNextPage ? page.search.pageInfo.endCursor : nil
        } while after != nil
        return nodes
    }

    private func organizationRepos() async throws -> [String] {
        let organizations: ViewerOrganizations = try await graphql(
            "{viewer{organizations(first:100){nodes{login}}}}")
        var repos: [String] = []
        for organization in organizations.viewer.organizations.nodes {
            var after: String?
            repeat {
                let page: OrganizationRepos = try await graphql(
                    """
                    query($login:String!,$after:String){organization(login:$login){
                      repositories(first:100,after:$after,isArchived:false){
                        pageInfo{hasNextPage endCursor} nodes{nameWithOwner}}}}
                    """, ["login": organization.login, "after": after])
                let connection = page.organization.repositories
                repos += connection.nodes.map(\.nameWithOwner)
                after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : nil
            } while after != nil
        }
        return repos
    }

    private static let refs = """
        refs(refPrefix:"refs/heads/",first:100,after:$after){
          pageInfo{hasNextPage endCursor}
          nodes{name branchProtectionRule{id}
            target{... on Commit{committedDate authors(first:100){totalCount nodes{user{login}}}}}}}
        """

    private func scanBranches(_ repos: [String], login: String) async throws -> [Branch] {
        let firstPages = try await concurrentMap(repos.chunked(5)) { group in
            var variables: Variables = ["after": nil]
            var definitions = ["$after:String"]
            var aliases: [String] = []
            for (index, repo) in group.enumerated() {
                let (owner, name) = split(repo)
                variables["o\(index)"] = owner
                variables["n\(index)"] = name
                definitions += ["$o\(index):String!", "$n\(index):String!"]
                aliases.append(
                    "r\(index):repository(owner:$o\(index),name:$n\(index)){"
                        + "nameWithOwner defaultBranchRef{name} \(Self.refs)}")
            }
            let query = "query(\(definitions.joined(separator: ","))){\(aliases.joined())}"
            let result: [String: RepositoryRefs] = try await graphql(query, variables)
            return Array(result.values)
        }.flatMap(\.self)

        let scanned = try await concurrentMap(firstPages) { repository in
            let (owner, name) = split(repository.nameWithOwner)
            var nodes = repository.refs.nodes
            var pageInfo = repository.refs.pageInfo
            while pageInfo.hasNextPage {
                let page: RepositoryPage = try await graphql(
                    "query($owner:String!,$name:String!,$after:String){"
                        + "repository(owner:$owner,name:$name){\(Self.refs)}}",
                    ["owner": owner, "name": name, "after": pageInfo.endCursor])
                nodes += page.repository.refs.nodes
                pageInfo = page.repository.refs.pageInfo
            }
            return (repository, nodes)
        }

        return try scanned.flatMap { repository, nodes in
            try nodes
                .filter {
                    $0.name != repository.defaultBranchRef?.name && $0.branchProtectionRule == nil
                }
                .map { ref in try branch(ref, in: repository.nameWithOwner, login: login) }
        }
    }

    private func branch(_ ref: RefNode, in repo: String, login: String) throws -> Branch {
        let authors = ref.target.authors
        guard authors.totalCount <= authors.nodes.count else {
            let message = "\(repo) \(ref.name): head commit has more than 100 authors"
            throw GitHubError(errorDescription: message)
        }
        return Branch(
            repo: repo, name: ref.name, committed: String(ref.target.committedDate.prefix(10)),
            headAuthoredByMe: authors.nodes.contains { $0.user?.login == login })
    }

    private func classify(_ candidates: [Branch], login: String) async throws -> [StrayBranch] {
        let batches = Dictionary(grouping: candidates, by: \.repo).values.flatMap { $0.chunked(20) }
        return try await concurrentMap(batches) { branches in
            let (owner, name) = split(branches[0].repo)
            var variables: Variables = ["owner": owner, "name": name]
            var definitions = ["$owner:String!", "$name:String!"]
            var aliases: [String] = []
            for (index, branch) in branches.enumerated() {
                variables["h\(index)"] = "refs/heads/\(branch.name)"
                variables["b\(index)"] = branch.name
                definitions += ["$h\(index):String!", "$b\(index):String!"]
                aliases.append(
                    """
                    h\(index):ref(qualifiedName:$h\(index)){associatedPullRequests(first:100){
                      totalCount nodes{number url state author{login}}}}
                    b\(index):pullRequests(baseRefName:$b\(index),first:100){
                      totalCount nodes{state author{login}}}
                    """)
            }
            let result: BranchPullRequests = try await graphql(
                "query(\(definitions.joined(separator: ","))){"
                    + "repository(owner:$owner,name:$name){\(aliases.joined(separator: "\n"))}}",
                variables)
            return try branches.enumerated().compactMap { index, branch in
                try stray(
                    branch, head: result.repository["h\(index)"]?.head?.associatedPullRequests,
                    base: result.repository["b\(index)"]?.base, login: login)
            }
        }.flatMap(\.self)
    }

    private func stray(
        _ branch: Branch, head: Connection<HeadPullRequest>?, base: Connection<BasePullRequest>?,
        login: String
    ) throws -> StrayBranch? {
        guard let head, let base else { return nil }
        guard head.totalCount <= head.nodes.count else {
            throw GitHubError(errorDescription: "\(branch.repo) \(branch.name): more than 100 PRs")
        }
        let isSharedBase =
            base.totalCount > base.nodes.count
            || base.nodes.contains { $0.state == "OPEN" || $0.author?.login != login }
        let isMine =
            head.nodes.isEmpty
            ? branch.headAuthoredByMe : head.nodes.contains { $0.author?.login == login }
        let hasOpenPullRequest = head.nodes.contains { $0.state == "OPEN" }
        guard !isSharedBase, isMine, !hasOpenPullRequest else { return nil }

        let kind: StrayBranch.Kind =
            head.nodes.contains { $0.state == "MERGED" }
            ? .merged : head.nodes.isEmpty ? .never : .closed
        let path = branch.name.split(separator: "/", omittingEmptySubsequences: false)
            .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }
            .joined(separator: "/")
        let compare = URL(string: "https://github.com/\(branch.repo)/compare/\(path)")!
        return StrayBranch(
            repo: split(branch.repo).name, name: branch.name, committed: branch.committed,
            kind: kind, pullRequests: head.nodes.map(\.number),
            url: head.nodes.last?.url ?? compare)
    }
}

private func split(_ nameWithOwner: String) -> (owner: String, name: String) {
    let parts = nameWithOwner.split(separator: "/", maxSplits: 1).map(String.init)
    return (parts.first ?? "", parts.last ?? "")
}

private func concurrentMap<T: Sendable, R: Sendable>(
    _ items: [T], limit: Int = 8, _ transform: @escaping @Sendable (T) async throws -> R
) async throws -> [R] {
    try await withThrowingTaskGroup(of: (Int, R).self) { group in
        var results = [R?](repeating: nil, count: items.count)
        var next = 0
        func enqueue() {
            guard next < items.count else { return }
            let index = next
            next += 1
            group.addTask { (index, try await transform(items[index])) }
        }
        for _ in 0..<limit { enqueue() }
        while let (index, result) = try await group.next() {
            results[index] = result
            enqueue()
        }
        return results.compactMap(\.self)
    }
}

extension Array {
    fileprivate func chunked(_ size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}
