import Foundation

struct Usage: Equatable, Sendable {
    struct Window: Equatable, Sendable {
        let name: String
        let utilization: Double
        let resetsAt: Date?

        /// A window that has reset holds no usage until the next request opens a new one.
        func percent(now: Date) -> Double {
            guard let resetsAt, resetsAt <= now else { return min(100, max(0, utilization)) }
            return 0
        }
    }

    let session: Window?
    let weekly: Window?
    let weeklyModels: [Window]

    static func decode(_ data: Data) throws -> Usage {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let raw = try decoder.decode(UsageResponse.self, from: data)
        return Usage(
            session: raw.fiveHour?.window("5-hour"),
            weekly: raw.sevenDay?.window("Weekly"),
            weeklyModels: [
                raw.sevenDayOpus?.window("Weekly Opus"),
                raw.sevenDaySonnet?.window("Weekly Sonnet"),
            ].compactMap { $0 })
    }

    /// The endpoint sends microseconds, which `ISO8601DateFormatter` rejects.
    fileprivate static func parseDate(_ text: String) -> Date? {
        ISO8601DateFormatter().date(from: text.replacing(/\.\d+/, with: ""))
    }
}

private struct UsageResponse: Decodable {
    struct Bucket: Decodable {
        let utilization: Double?
        let resetsAt: String?

        func window(_ name: String) -> Usage.Window {
            Usage.Window(
                name: name, utilization: utilization ?? 0,
                resetsAt: resetsAt.flatMap(Usage.parseDate))
        }
    }

    let fiveHour: Bucket?
    let sevenDay: Bucket?
    let sevenDayOpus: Bucket?
    let sevenDaySonnet: Bucket?
}

enum Plan {
    /// Names the subscription, such as "Max 5x" or "Team \u{00B7} Max 5x".
    static func name(fromProfile data: Data) -> String? {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let organization = try? decoder.decode(Profile.self, from: data).organization,
            let type = organization.organizationType
        else { return nil }
        let base =
            [
                "claude_pro": "Pro", "claude_max": "Max", "claude_team": "Team",
                "claude_enterprise": "Enterprise",
            ][type]
        let multiplier = organization.rateLimitTier?.firstMatch(of: /max_(\d+x)/).map {
            "Max \($0.1)"
        }
        switch (base, multiplier) {
        case ("Max", let multiplier?): return multiplier
        case (let base?, let multiplier?): return "\(base) \u{00B7} \(multiplier)"
        case (let base?, nil): return base
        case (nil, _): return multiplier
        }
    }
}

private struct Profile: Decodable {
    struct Organization: Decodable {
        let organizationType: String?
        let rateLimitTier: String?
    }

    let organization: Organization?
}

enum UsageAPI {
    // Undocumented endpoints that accept only OAuth tokens.
    static func fetch(token: String) async throws -> Usage {
        try Usage.decode(await get("usage", token: token))
    }

    static func plan(token: String) async throws -> String? {
        Plan.name(fromProfile: try await get("profile", token: token))
    }

    private static func get(_ path: String, token: String) async throws -> Data {
        var request = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/\(path)")!)
        request.timeoutInterval = 10
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("rex-extensions", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200: return data
        case 401:
            throw ClaudeLoginError(
                errorDescription: "Claude rejected the login. Log in again with /login in pi.")
        case 429: throw ClaudeLoginError(errorDescription: "Rate limited by Claude.")
        case let status:
            throw ClaudeLoginError(errorDescription: "Claude usage returned HTTP \(status ?? 0).")
        }
    }
}

enum UsageFormat {
    static func countdown(to date: Date, now: Date) -> String {
        let minutes = max(0, Int((date.timeIntervalSince(now) / 60).rounded()))
        let days = minutes / 1440
        let hours = minutes % 1440 / 60
        if days > 0 { return "\(days)d \(hours)h" }
        return hours > 0 ? "\(hours)h \(minutes % 60)m" : "\(minutes)m"
    }

    static func age(since date: Date, now: Date) -> String {
        let minutes = Int(now.timeIntervalSince(date) / 60)
        return minutes < 1 ? "just now" : "\(countdown(to: now, now: date)) ago"
    }

    static func clock(_ date: Date, now: Date) -> String {
        let sameDay = Calendar.current.isDate(date, inSameDayAs: now)
        return date.formatted(
            sameDay
                ? .dateTime.hour().minute()
                : .dateTime.weekday(.abbreviated).hour().minute())
    }
}
