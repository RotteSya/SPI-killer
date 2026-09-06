import Foundation
import CryptoKit
import Security

enum OfficialAccountFailure: Error { case credentialUnavailable, missingCredential, changed, invalidResponse }

/// Strictly decoded before any credential, balance, permission or usage mirror changes.
struct OfficialAccountResponse: Decodable {
    let deviceToken: String?
    let balanceQuestions: Int
    let balanceVersion: String?
    let cliEnabled: Bool?
    let totalQuestions: Int?
    let totalInputTokens: Int?
    let totalOutputTokens: Int?
    enum CodingKeys: String, CodingKey {
        case deviceToken = "device_token", balanceQuestions = "balance_questions", balanceVersion = "balance_version"
        case cliEnabled = "cli_enabled", totalQuestions = "total_questions"
        case totalInputTokens = "total_input_tokens", totalOutputTokens = "total_output_tokens"
    }
    func validate(registration: Bool) throws {
        guard balanceQuestions >= 0,
              [totalQuestions, totalInputTokens, totalOutputTokens].allSatisfy({ $0 == nil || $0! >= 0 }),
              balanceVersion == nil || BalanceVersion.canonical(balanceVersion!) != nil else {
            throw OfficialAccountFailure.invalidResponse
        }
        if registration {
            guard let token = deviceToken, (16...512).contains(token.utf8.count),
                  token.utf8.allSatisfy({ (33...126).contains($0) }) else { throw OfficialAccountFailure.invalidResponse }
        }
    }
}

/// One synchronized owner for credentials and the official account mirror. The production
/// instance keeps the original Keychain namespace and defaults. Tests use the same operations
/// with a distinct Security service and defaults suite, never the user's paid credential.
final class OfficialAccountState: @unchecked Sendable {
    struct RegistrationTicket {
        let baseURL: String
        let generation: UInt64
        let attempt: String
    }
    enum RegistrationPreparation { case existing(String), request(RegistrationTicket) }
    struct RefreshTicket {
        let account: OfficialAPI.CaptureAccount
        let sequence: UInt64
    }
    let registrationGate = RegistrationGate()
    private let defaults: UserDefaults
    private let secrets: KeychainStore.Access
    private let baseURL: () -> String
    private let onChange: () -> Void
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var notificationRevision: UInt64 = 0
    private var lastBase: String?
    private var currentBinding: String?
    private var refreshSequence: UInt64 = 0
    private var appliedRefreshSequence: UInt64 = 0
    private static let mirrorKeys = ["balanceQuestions", "balanceVersion", "cliEnabled", "credentialRejected",
                                     "totalQuestions", "totalInputTokens", "totalOutputTokens"]

    init(defaults: UserDefaults = .standard, secrets: KeychainStore.Access = .live,
         baseURL: @escaping () -> String = { OfficialAPI.baseURL }, onChange: @escaping () -> Void = {}) {
        self.defaults = defaults; self.secrets = secrets; self.baseURL = baseURL; self.onChange = onChange
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        let revision = notificationRevision
        defer {
            let changed = revision != notificationRevision
            lock.unlock()
            if changed { onChange() }
        }
        return try body()
    }

    private func observeBaseLocked() -> String {
        let base = baseURL()
        if let previous = lastBase, previous != base {
            generation &+= 1
            clearMirrorLocked()
        }
        lastBase = base
        return base
    }

    private func credentialLocked() -> KeychainStore.ReadResult {
        let result = secrets.read("official.deviceToken")
        guard result == .missing else { return result }
        guard let legacy = defaults.string(forKey: "official.deviceToken"), !legacy.isEmpty else { return .missing }
        // A failed migration keeps the sole recovery copy. An unavailable Keychain above is
        // never treated as empty, nor overwritten using a potentially older plaintext copy.
        if secrets.write(legacy, "official.deviceToken") { defaults.removeObject(forKey: "official.deviceToken") }
        return .value(legacy)
    }

    private func clearMirrorLocked() {
        for key in Self.mirrorKeys { defaults.removeObject(forKey: "official." + key) }
        notificationRevision &+= 1
    }

    private func identityLocked() -> OfficialAPI.CaptureAccount? {
        let base = observeBaseLocked()
        guard case .value(let token) = credentialLocked() else { return nil }
        let binding = SHA256.hash(data: Data((base + "\n" + token).utf8)).map { String(format: "%02x", $0) }.joined()
        let saved = defaults.string(forKey: "official.accountBinding")
        if currentBinding != binding || saved != binding {
            if currentBinding != nil || (saved != nil && saved != binding) || (saved == nil && base != OfficialAPI.defaultBaseURL) {
                generation &+= 1
                clearMirrorLocked()
            }
            currentBinding = binding
        }
        if saved != binding { defaults.set(binding, forKey: "official.accountBinding") }
        return .init(token: token, baseURL: base, generation: generation)
    }

    var account: OfficialAPI.CaptureAccount? { locked { identityLocked() } }
    var token: String? { locked { credentialLocked().value } }
    func matches(_ account: OfficialAPI.CaptureAccount) -> Bool { locked { identityLocked() == account } }

    func value(_ key: String) -> Any? {
        locked { _ = identityLocked(); return defaults.object(forKey: "official." + key) }
    }
    func setValue(_ value: Any?, for key: String) {
        locked {
            _ = identityLocked()
            if let value { defaults.set(value, forKey: "official." + key) }
            else { defaults.removeObject(forKey: "official." + key) }
            notificationRevision &+= 1
        }
    }

    @discardableResult
    func replaceCredential(_ token: String?) -> Bool {
        locked {
            guard secrets.write(token, "official.deviceToken") else { return false }
            defaults.removeObject(forKey: "official.deviceToken")
            generation &+= 1; currentBinding = nil
            defaults.removeObject(forKey: "official.accountBinding")
            clearMirrorLocked()
            _ = identityLocked()
            return true
        }
    }

    /// Both deletions must succeed before the caller may claim a new device. Delete the retry
    /// credential first so an unsuccessful reset cannot resurrect a discarded device later.
    @discardableResult
    func resetCredential() -> Bool {
        locked {
            guard secrets.write(nil, "official.registrationAttempt"),
                  secrets.write(nil, "official.deviceToken") else { return false }
            defaults.removeObject(forKey: "official.deviceToken")
            defaults.removeObject(forKey: "official.accountBinding")
            generation &+= 1; currentBinding = nil
            clearMirrorLocked()
            return true
        }
    }

    func prepareRegistration() throws -> RegistrationPreparation {
        try locked {
            let base = observeBaseLocked()
            switch credentialLocked() {
            case .value(let token): _ = identityLocked(); return .existing(token)
            case .unavailable: throw OfficialAccountFailure.credentialUnavailable
            case .missing: break
            }
            let attempt: String
            switch secrets.read("official.registrationAttempt") {
            case .value(let existing):
                guard existing.count == 43, existing.utf8.allSatisfy({
                    (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
                }) else { throw OfficialAccountFailure.credentialUnavailable }
                attempt = existing
            case .unavailable: throw OfficialAccountFailure.credentialUnavailable
            case .missing:
                var bytes = [UInt8](repeating: 0, count: 32)
                guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                    throw OfficialAccountFailure.credentialUnavailable
                }
                attempt = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
                    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
                guard secrets.write(attempt, "official.registrationAttempt"),
                      secrets.read("official.registrationAttempt") == .value(attempt) else {
                    throw OfficialAccountFailure.credentialUnavailable
                }
            }
            return .request(.init(baseURL: base, generation: generation, attempt: attempt))
        }
    }

    func acceptRegistration(_ response: OfficialAccountResponse, ticket: RegistrationTicket) throws -> String {
        try response.validate(registration: true)
        return try locked {
            guard observeBaseLocked() == ticket.baseURL, generation == ticket.generation,
                  credentialLocked() == .missing, secrets.read("official.registrationAttempt") == .value(ticket.attempt) else {
                throw OfficialAccountFailure.changed
            }
            let token = response.deviceToken!
            guard secrets.write(token, "official.deviceToken"), secrets.read("official.deviceToken") == .value(token) else {
                throw OfficialAccountFailure.credentialUnavailable
            }
            defaults.removeObject(forKey: "official.deviceToken")
            // A leftover attempt is harmless while a saved token exists; keep it if deletion
            // fails, and require its deletion before any later explicit reset.
            _ = secrets.write(nil, "official.registrationAttempt")
            clearMirrorLocked()
            _ = identityLocked()
            applyResponseLocked(response)
            return token
        }
    }

    func prepareRefresh() throws -> RefreshTicket {
        try locked {
            guard let account = identityLocked() else {
                if case .unavailable = credentialLocked() { throw OfficialAccountFailure.credentialUnavailable }
                throw OfficialAccountFailure.missingCredential
            }
            refreshSequence &+= 1
            return .init(account: account, sequence: refreshSequence)
        }
    }

    func acceptRefresh(_ response: OfficialAccountResponse, ticket: RefreshTicket) throws {
        try response.validate(registration: false)
        try locked {
            guard identityLocked() == ticket.account else { throw OfficialAccountFailure.changed }
            guard ticket.sequence >= appliedRefreshSequence else { return }
            guard acceptsBalanceLocked(response.balanceVersion) else { return }
            appliedRefreshSequence = ticket.sequence
            applyResponseLocked(response)
        }
    }

    func rejectCredential(for account: OfficialAPI.CaptureAccount, refreshSequence: UInt64? = nil) {
        locked {
            guard identityLocked() == account else { return }
            if let refreshSequence, refreshSequence < appliedRefreshSequence { return }
            defaults.removeObject(forKey: "official.balanceQuestions")
            defaults.set(true, forKey: "official.credentialRejected")
            notificationRevision &+= 1
        }
    }

    private func acceptsBalanceLocked(_ version: String?) -> Bool {
        let current = defaults.string(forKey: "official.balanceVersion")
        return version.map { BalanceVersion.accepts(incoming: $0, current: current) } ?? (current == nil)
    }
    private func applyResponseLocked(_ response: OfficialAccountResponse) {
        defaults.set(false, forKey: "official.credentialRejected")
        defaults.set(response.balanceQuestions, forKey: "official.balanceQuestions")
        if let version = response.balanceVersion { defaults.set(version, forKey: "official.balanceVersion") }
        if let cli = response.cliEnabled { defaults.set(cli, forKey: "official.cliEnabled") }
        for (key, value) in [("totalQuestions", response.totalQuestions), ("totalInputTokens", response.totalInputTokens),
                             ("totalOutputTokens", response.totalOutputTokens)] {
            // The accepted server snapshot is authoritative, including corrections to local
            // optimistic usage. The identity, request order and balance version are checked
            // before reaching this method; do not preserve an accidentally inflated mirror.
            if let value { defaults.set(value, forKey: "official." + key) }
        }
        notificationRevision &+= 1
    }

    @discardableResult
    func applyBalance(_ balance: Int, version: String?, totals: OfficialAccountTotals? = nil,
                      account: OfficialAPI.CaptureAccount? = nil) -> Bool {
        locked {
            let current = identityLocked()
            guard account == nil || account == current, balance >= 0, acceptsBalanceLocked(version),
                  totals == nil || (totals!.isValid && version != nil) else { return false }
            defaults.set(balance, forKey: "official.balanceQuestions")
            if let version { defaults.set(version, forKey: "official.balanceVersion") }
            if let totals {
                defaults.set(totals.questions, forKey: "official.totalQuestions")
                defaults.set(totals.inputTokens, forKey: "official.totalInputTokens")
                defaults.set(totals.outputTokens, forKey: "official.totalOutputTokens")
            }
            defaults.set(false, forKey: "official.credentialRejected")
            notificationRevision &+= 1
            return true
        }
    }

}
