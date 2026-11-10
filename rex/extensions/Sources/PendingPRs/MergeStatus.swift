import Foundation

private let failedConclusions: Set = [
    "FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE",
]
private let mergeableStates: Set = ["CLEAN", "HAS_HOOKS", "UNSTABLE"]

extension CheckContext {
    var label: String { name ?? context ?? "?" }

    var failed: Bool {
        typename == "CheckRun"
            ? failedConclusions.contains(conclusion ?? "") : ["FAILURE", "ERROR"].contains(state)
    }

    var running: Bool {
        typename == "CheckRun" ? status != "COMPLETED" : ["PENDING", "EXPECTED"].contains(state)
    }
}

extension OpenNode {
    var pullRequest: PullRequest {
        let checks = commits.nodes.first?.commit.statusCheckRollup?.contexts.nodes ?? []
        let failing = checks.filter(\.failed)
        let running = checks.filter(\.running)
        let passed = checks.count - failing.count - running.count
        let checkSummary = checks.isEmpty ? [] : ["\(passed)/\(checks.count) checks passed"]
        let failingNames = failing.map(\.label).joined(separator: ", ")
        let approvals = list("approved by", reviewers("APPROVED"))

        if isDraft {
            return make(.draft, "draft", list("failing:", failing.map(\.label)) + checkSummary)
        }
        if mergeableStates.contains(mergeStateStatus) {
            let optional =
                (failing.isEmpty ? [] : ["optional checks failing: \(failingNames)"])
                + (running.isEmpty ? [] : [count(running.count, "optional check") + " running"])
            let reason = approvals.isEmpty ? "ready" : "approved"
            return make(.ready, reason, approvals + checkSummary + optional)
        }

        var action: [String] = []
        if mergeable == "CONFLICTING" { action.append("conflicts") }
        if !failing.isEmpty { action.append(count(failing.count, "check") + " failing") }
        if reviewDecision == "CHANGES_REQUESTED" { action.append("changes requested") }
        if mergeStateStatus == "BEHIND" { action.append("behind base") }

        var waiting: [String] = []
        if reviewDecision == "REVIEW_REQUIRED" { waiting.append("needs review") }
        if !running.isEmpty { waiting.append(count(running.count, "check") + " running") }

        let requested = reviewRequests.nodes.compactMap {
            $0.requestedReviewer?.login ?? $0.requestedReviewer?.name
        }
        let details =
            list("changes requested by", reviewers("CHANGES_REQUESTED"))
            + list("review requested from", requested) + approvals + checkSummary
            + list("failing:", failing.map(\.label))
        if let first = action.first {
            return make(.action, first, Array(action.dropFirst()) + waiting + details)
        }
        if let first = waiting.first {
            return make(.waiting, first, Array(waiting.dropFirst()) + details)
        }
        let reason =
            mergeStateStatus == "UNKNOWN" ? "merge state pending" : "blocked by a branch rule"
        return make(.waiting, reason, details)
    }

    func make(_ stage: PullRequest.Stage, _ reason: String, _ details: [String]) -> PullRequest {
        PullRequest(
            repo: repository.name, number: number, title: title, url: url, stage: stage,
            updated: updatedAt, reason: reason, details: details)
    }

    private func reviewers(_ state: String) -> [String] {
        latestOpinionatedReviews.nodes.filter { $0.state == state }.map {
            $0.author?.login ?? "ghost"
        }
    }
}

private func list(_ label: String, _ names: [String]) -> [String] {
    names.isEmpty ? [] : ["\(label) \(names.joined(separator: ", "))"]
}

private func count(_ number: Int, _ noun: String) -> String {
    number == 1 ? "1 \(noun)" : "\(number) \(noun)s"
}
