import Foundation
import Testing

@testable import ClaudeUsage

@Test func usageReadsMicrosecondTimestamps() throws {
    let json = #"""
        {"five_hour":{"utilization":43.0,"resets_at":"2026-11-02T10:00:00.314789+00:00"},
         "seven_day":{"utilization":21.0,"resets_at":"2026-11-07T22:00:00+00:00"},
         "seven_day_opus":null,"extra_usage":{"is_enabled":false}}
        """#
    let usage = try Usage.decode(Data(json.utf8))
    #expect(usage.session?.utilization == 43)
    #expect(usage.session?.resetsAt == ISO8601DateFormatter().date(from: "2026-11-02T10:00:00Z"))
    #expect(usage.weekly?.resetsAt == ISO8601DateFormatter().date(from: "2026-11-07T22:00:00Z"))
    #expect(usage.weeklyModels.isEmpty)
}

@Test func usageDropsToZeroAfterReset() {
    let now = Date(timeIntervalSince1970: 10_000)
    let reset = Usage.Window(name: "5-hour", utilization: 80, resetsAt: now.addingTimeInterval(-1))
    let live = Usage.Window(name: "5-hour", utilization: 80, resetsAt: now.addingTimeInterval(60))
    #expect(reset.percent(now: now) == 0)
    #expect(live.percent(now: now) == 80)
}

@Test func countdownPicksTheLargestUnits() {
    let now = Date(timeIntervalSince1970: 0)
    #expect(UsageFormat.countdown(to: now.addingTimeInterval(4 * 60), now: now) == "4m")
    #expect(
        UsageFormat.countdown(to: now.addingTimeInterval(2 * 3600 + 13 * 60), now: now) == "2h 13m")
    #expect(
        UsageFormat.countdown(to: now.addingTimeInterval(3 * 86400 + 4 * 3600), now: now) == "3d 4h"
    )
}

@Test func ageSaysJustNowUnderAMinute() {
    let now = Date(timeIntervalSince1970: 100_000)
    #expect(UsageFormat.age(since: now.addingTimeInterval(-20), now: now) == "just now")
    #expect(UsageFormat.age(since: now.addingTimeInterval(-7200), now: now) == "2h 0m ago")
}

@Test func loginNeedsAnAnthropicOAuthEntry() throws {
    let entry: [String: Any] = [
        "type": "oauth", "access": "a", "refresh": "r", "expires": 1_000_000.0,
    ]
    let credential = try ClaudeLogin.anthropic(in: ["anthropic": entry])
    #expect(credential.expires == Date(timeIntervalSince1970: 1000))
    #expect(throws: ClaudeLoginError.self) {
        try ClaudeLogin.anthropic(in: ["anthropic": ["type": "api_key", "key": "k"]])
    }
}

@Test func loginRefreshesWithFiveMinutesLeft() {
    let now = Date(timeIntervalSince1970: 0)
    let credential = OAuthCredential(
        access: "a", refresh: "r", expires: now.addingTimeInterval(299))
    #expect(credential.expiresSoon(now: now))
    #expect(
        !OAuthCredential(access: "a", refresh: "r", expires: now.addingTimeInterval(301))
            .expiresSoon(now: now))
}

@Test func planNamesTheSubscription() {
    func plan(_ type: String, _ tier: String) -> String? {
        let json =
            #"{"organization":{"organization_type":"\#(type)","rate_limit_tier":"\#(tier)"}}"#
        return Plan.name(fromProfile: Data(json.utf8))
    }
    #expect(plan("claude_max", "default_claude_max_20x") == "Max 20x")
    #expect(plan("claude_team", "default_claude_max_5x") == "Team · Max 5x")
    #expect(plan("claude_pro", "default_claude_pro") == "Pro")
}
