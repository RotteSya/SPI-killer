import Foundation
import CryptoKit

struct ObjectiveExperimentConfig: Codable, Equatable {
    let variant: String
    let `protocol`: String?
    let promptVariant: String

    enum CodingKeys: String, CodingKey {
        case variant, `protocol`
        case promptVariant = "prompt_variant"
    }
}

struct TelemetryRemoteConfig: Codable, Equatable {
    let enabled: Bool
    let maxBatchSize: Int
    let maxQueueAgeDays: Int

    enum CodingKeys: String, CodingKey {
        case enabled
        case maxBatchSize = "max_batch_size"
        case maxQueueAgeDays = "max_queue_age_days"
    }
}

struct ScreenQueryRemoteConfig: Codable, Equatable {
    let capabilities: [String]
    let enabledProfiles: [String]?
    enum CodingKeys: String, CodingKey {
        case capabilities
        case enabledProfiles = "enabled_profiles"
    }
}

struct PaymentPackRemoteConfig: Codable, Equatable {
    let id: String
    let questions: Int
    let amountMinor: Int
    enum CodingKeys: String, CodingKey { case id, questions; case amountMinor = "amount_minor" }
}

struct PaymentsRemoteConfig: Codable, Equatable {
    let purchaseSessions: Bool
    let catalogVersion: String
    let currency: String
    let packs: [PaymentPackRemoteConfig]
    enum CodingKeys: String, CodingKey {
        case purchaseSessions = "purchase_sessions"
        case catalogVersion = "catalog_version"
        case currency, packs
    }
}

struct NotchClientConfig: Codable, Equatable {
    let schemaVersion: Int
    let revision: String
    let objectiveResultV1: ObjectiveExperimentConfig
    let telemetry: TelemetryRemoteConfig
    var screenQuery: ScreenQueryRemoteConfig? = nil
    var payments: PaymentsRemoteConfig? = nil

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case revision
        case objectiveResultV1 = "objective_result_v1"
        case telemetry
        case screenQuery = "screen_query"
        case payments
    }

    static let base = NotchClientConfig(
        schemaVersion: 1,
        revision: "base",
        objectiveResultV1: .init(variant: "control", protocol: nil, promptVariant: "legacy"),
        telemetry: .init(enabled: true, maxBatchSize: 50, maxQueueAgeDays: 7)
    )

    var accepted: Bool {
        schemaVersion == 1 && (objectiveResultV1.protocol == nil
            || objectiveResultV1.protocol == "objective_v1")
    }
}

@MainActor
final class ClientConfigService {
    static let shared = ClientConfigService()
    private struct Cache: Codable {
        let binding: String
        let fetchedAt: Date
        let config: NotchClientConfig
    }
    private let cacheKey = "clientConfig.v2.cache"
    private let defaults: UserDefaults
    private let account: () -> OfficialAPI.CaptureAccount?
    private let now: () -> Date
    private let session: URLSession
    private var owner: OfficialAPI.CaptureAccount?
    private var observedOwner = false
    private var cache: Cache?
    private var requestID: UUID?
    private var refreshTask: Task<Void, Never>?

    var current: NotchClientConfig {
        synchronizeOwner()
        guard let cache else { return .base }
        guard isFresh(cache) else {
            self.cache = nil
            defaults.removeObject(forKey: cacheKey)
            return .base
        }
        return cache.config
    }

    init(defaults: UserDefaults = .standard,
         account: @escaping () -> OfficialAPI.CaptureAccount? = { OfficialAPI.accountState.account },
         now: @escaping () -> Date = Date.init, session: URLSession = .shared) {
        self.defaults = defaults; self.account = account; self.now = now; self.session = session
        // V1 had no account/service binding and cannot safely be migrated.
        defaults.removeObject(forKey: "clientConfig.v1.cache")
        synchronizeOwner()
    }

    deinit { refreshTask?.cancel() }

    private func binding(_ owner: OfficialAPI.CaptureAccount) -> String {
        // Length-prefixed fields keep the persisted digest unambiguous without storing a token.
        let fields = [owner.baseURL, owner.token].map { "\($0.utf8.count):\($0)" }.joined()
        return SHA256.hash(data: Data(fields.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func isFresh(_ cache: Cache) -> Bool {
        let age = now().timeIntervalSince(cache.fetchedAt)
        return age.isFinite && age >= 0 && age <= 24 * 60 * 60 && cache.config.accepted
    }

    private func synchronizeOwner() {
        let next = account()
        guard !observedOwner || next != owner else { return }
        let firstObservation = !observedOwner
        observedOwner = true
        refreshTask?.cancel(); refreshTask = nil; requestID = nil
        owner = next; cache = nil
        if firstObservation, let next,
           let data = defaults.data(forKey: cacheKey), data.count <= 131_072,
           let saved = try? JSONDecoder().decode(Cache.self, from: data),
           saved.binding == binding(next), isFresh(saved) {
            cache = saved
        } else {
            defaults.removeObject(forKey: cacheKey)
        }
    }

    @discardableResult
    func refresh() -> Task<Void, Never>? {
        synchronizeOwner()
        guard let owner, let url = URL(string: owner.baseURL + "/v1/client-config") else { return nil }
        if let refreshTask { return refreshTask }
        let id = UUID()
        requestID = id
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("Bearer \(owner.token)", forHTTPHeaderField: "Authorization")
        request.setValue(OfficialAPI.appVersion, forHTTPHeaderField: "X-App-Version")
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                // A cancelled request may finish after its replacement has started.
                if self.requestID == id { self.refreshTask = nil; self.requestID = nil }
            }
            guard let (status, data) = try? await OfficialAPI.readAccountHTTP(request, session: self.session),
                  !Task.isCancelled, self.requestID == id, self.account() == owner,
                  status == 200,
                  let decoded = try? JSONDecoder().decode(NotchClientConfig.self, from: data),
                  decoded.accepted else { return }
            let saved = Cache(binding: self.binding(owner), fetchedAt: self.now(), config: decoded)
            self.cache = saved
            if let data = try? JSONEncoder().encode(saved) { self.defaults.set(data, forKey: self.cacheKey) }
        }
        refreshTask = task
        return task
    }
}
