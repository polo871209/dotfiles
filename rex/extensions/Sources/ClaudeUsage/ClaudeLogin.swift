import Foundation

struct ClaudeLoginError: LocalizedError {
    let errorDescription: String?
}

struct OAuthCredential: Equatable {
    let access: String
    let refresh: String
    let expires: Date

    /// pi refreshes a token with less than five minutes left, so this matches it and both refresh once.
    func expiresSoon(now: Date) -> Bool { expires.timeIntervalSince(now) < 300 }
}

/// The Claude login that pi stores in `~/.pi/agent/auth.json`. A refresh rotates the refresh token,
/// so it runs under pi's lock and writes the new token back, or pi's next refresh fails.
enum ClaudeLogin {
    static let authPath = NSHomeDirectory() + "/.pi/agent/auth.json"

    static func accessToken() async throws -> String {
        let credential = try anthropic(in: readAuth())
        guard credential.expiresSoon(now: Date()) else { return credential.access }
        return try await withAuthLock {
            var auth = try readAuth()
            let current = try anthropic(in: auth)
            guard current.expiresSoon(now: Date()) else { return current.access }
            let next = try await refresh(current.refresh)
            auth["anthropic"] = [
                "type": "oauth", "refresh": next.refresh, "access": next.access,
                "expires": Int(next.expires.timeIntervalSince1970 * 1000),
            ]
            try writeAuth(auth)
            return next.access
        }
    }

    static func anthropic(in auth: [String: Any]) throws -> OAuthCredential {
        guard let entry = auth["anthropic"] as? [String: Any], entry["type"] as? String == "oauth",
            let access = entry["access"] as? String, let refresh = entry["refresh"] as? String,
            let expires = entry["expires"] as? Double
        else { throw ClaudeLoginError(errorDescription: "Log in to Claude with /login in pi.") }
        return OAuthCredential(
            access: access, refresh: refresh, expires: Date(timeIntervalSince1970: expires / 1000))
    }

    private static func readAuth() throws -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: authPath),
            let auth = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw ClaudeLoginError(errorDescription: "Log in to Claude with /login in pi.") }
        return auth
    }

    private static func writeAuth(_ auth: [String: Any]) throws {
        let data = try JSONSerialization.data(
            withJSONObject: auth, options: [.prettyPrinted, .withoutEscapingSlashes])
        let temporary = authPath + ".rex-\(getpid())"
        guard
            FileManager.default.createFile(
                atPath: temporary, contents: data, attributes: [.posixPermissions: 0o600]),
            rename(temporary, authPath) == 0
        else {
            unlink(temporary)
            throw ClaudeLoginError(errorDescription: "Could not save the refreshed Claude login.")
        }
    }

    // Matches proper-lockfile as pi uses it: a `.lock` directory, stale after 30 seconds.
    private static func withAuthLock<T>(_ body: () async throws -> T) async throws -> T {
        let lockPath = authPath + ".lock"
        let deadline = Date().addingTimeInterval(30)
        while mkdir(lockPath, 0o755) != 0 {
            guard errno == EEXIST, Date() < deadline else {
                throw ClaudeLoginError(errorDescription: "pi holds the Claude login lock.")
            }
            let modified =
                (try? FileManager.default.attributesOfItem(atPath: lockPath))?[.modificationDate]
                as? Date
            if let modified, modified.timeIntervalSinceNow < -30 {
                rmdir(lockPath)
            } else {
                try await Task.sleep(for: .milliseconds(200))
            }
        }
        defer { rmdir(lockPath) }
        return try await body()
    }

    // Adapted from pi-ai 1.4.0 dist/auth/oauth/anthropic.js, refreshAnthropicToken.
    private static func refresh(_ refreshToken: String) async throws -> OAuthCredential {
        var request = URLRequest(url: URL(string: "https://platform.claude.com/v1/oauth/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "grant_type": "refresh_token",
            "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            "refresh_token": refreshToken,
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let access = body["access_token"] as? String,
            let refresh = body["refresh_token"] as? String,
            let expiresIn = body["expires_in"] as? Double
        else {
            throw ClaudeLoginError(
                errorDescription: "Claude login refresh failed. Log in again with /login in pi.")
        }
        return OAuthCredential(
            access: access, refresh: refresh, expires: Date().addingTimeInterval(expiresIn - 300))
    }
}
