import Foundation

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
    private struct Cache: Codable { let fetchedAt: Date; let config: NotchClientConfig }
    private let cacheKey = "clientConfig.v1.cache"
    private(set) var current: NotchClientConfig = .base
    private var refreshing = false

    private init() {
        if let data = UserDefaults.standard.data(forKey: cacheKey),
           let cache = try? JSONDecoder().decode(Cache.self, from: data),
           Date().timeIntervalSince(cache.fetchedAt) <= 24 * 60 * 60,
           cache.config.accepted {
            current = cache.config
        }
    }

    func refresh() {
        guard !refreshing, let token = OfficialAPI.deviceToken,
              let url = URL(string: OfficialAPI.baseURL + "/v1/client-config") else { return }
        refreshing = true
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(OfficialAPI.appVersion, forHTTPHeaderField: "X-App-Version")
        Task {
            defer { refreshing = false }
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let decoded = try? JSONDecoder().decode(NotchClientConfig.self, from: data),
                  decoded.accepted else { return }
            if decoded != current {
                current = decoded
            }
            if let cache = try? JSONEncoder().encode(Cache(fetchedAt: Date(), config: decoded)) {
                UserDefaults.standard.set(cache, forKey: cacheKey)
            }
        }
    }
}
