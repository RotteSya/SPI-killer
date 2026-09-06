import AppKit
import Foundation
import CryptoKit

struct ProductTelemetryEvent: Codable, Equatable, Identifiable {
    let eventID: UUID
    let captureID: UUID?
    let occurredAt: Date
    let eventName: String
    var trigger: String?
    var channel: String?
    var mode: String?
    var depth: String?
    var contextCount: Int?
    var questionKind: String?
    var resultState: String?
    var parserPath: String?
    var errorCode: String?
    var action: String?
    var captureMs: Int?
    var firstTokenMs: Int?
    var totalMs: Int?
    var configRevision: String?
    var variant: String?
    var profileID: String?
    var profileVersion: String?
    var sourceGroup: String?
    var sourceMethod: String?
    var usableResult: Bool?
    var completionKind: String?
    var operation: String?
    var sessionID: UUID?
    var consentEpoch: Int?
    var queueDropCount: Int?
    var eventSequence: Int?

    var id: UUID { eventID }

    enum CodingKeys: String, CodingKey {
        case eventID = "event_id", captureID = "capture_id", occurredAt = "occurred_at"
        case eventName = "event_name", trigger, channel, mode, depth
        case contextCount = "context_count", questionKind = "question_kind"
        case resultState = "result_state", parserPath = "parser_path", errorCode = "error_code"
        case action, captureMs = "capture_ms", firstTokenMs = "first_token_ms", totalMs = "total_ms"
        case configRevision = "config_revision", variant
        case profileID = "profile_id", profileVersion = "profile_version", sourceGroup = "source_group", sourceMethod = "source_method"
        case usableResult = "usable_result", completionKind = "completion_kind", operation, sessionID = "session_id"
        case consentEpoch = "consent_epoch", queueDropCount = "queue_drop_count"
        case eventSequence = "event_sequence"
    }
}

@MainActor
final class ProductTelemetry {
    static let shared = ProductTelemetry()
    static let sharingKey = "telemetry.reliabilitySharingEnabled"
    static let noticeKey = "telemetry.noticeShownVersion"

    private struct Batch: Encodable {
        let schemaVersion = 2
        let events: [ProductTelemetryEvent]
        enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", events }
    }
    private struct PreferenceBody: Encodable {
        let schemaVersion = 1
        let preference: ObservationPreference
        enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", preference }
    }
    private struct CoverageBody: Encodable {
        let schemaVersion = 1
        let coverage: ObservationCoverage
        enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", coverage }
    }
    private struct RemoteState: Decodable {
        let serverTime: Date
        let preference: ObservationPreference?
        let telemetryEnabled: Bool?
        enum CodingKeys: String, CodingKey {
            case serverTime = "server_time", preference, telemetryEnabled = "telemetry_enabled"
        }
    }
    private struct BatchReceipt: Decodable { let accepted: Int; let duplicate: Int; let rejected: Int }
    private struct CoverageReceipt: Decodable { let accepted: Bool; let coverage: ObservationCoverage }
    private enum UploadFailure: Error { case transport, response, clock }

    struct Environment {
        var token: @MainActor () -> String?
        var baseURL: @MainActor () -> String
        var appVersion: @MainActor () -> String
        var config: @MainActor () -> TelemetryRemoteConfig
        var source: @MainActor () -> (group: String, method: String) = { ("unknown", "unknown") }
        @MainActor static var live: Self {
            .init(token: { OfficialAPI.deviceToken }, baseURL: { OfficialAPI.baseURL },
                  appVersion: { OfficialAPI.appVersion }, config: { ClientConfigService.shared.current.telemetry },
                  source: { DeviceSourceSelection.shared.telemetrySource })
        }
    }
    private let defaults: UserDefaults
    private let session: URLSession
    private let environment: Environment
    private let scheduleAutomatically: Bool
    private var journal: ObservationJournal
    private var uploadID: UUID?
    private var uploadTask: Task<Void, Never>?
    private var retryIndex = 0
    private var scheduled: DispatchWorkItem?
    private let retryDelays: [TimeInterval] = [60, 300, 1_800]
    private let fileURL: URL

    var sharingEnabled: Bool {
        get { journal.preference.sharingEnabled }
        set {
            guard newValue != sharingEnabled else { return }
            defaults.set(newValue, forKey: Self.sharingKey)
            uploadTask?.cancel()
            uploadTask = nil
            uploadID = nil
            scheduled?.cancel()
            journal.setSharing(newValue, now: Date())
            // Remove the old file before persisting the minimal preference-only state.
            if !newValue { try? FileManager.default.removeItem(at: fileURL) }
            persist()
            schedule(after: 0)
        }
    }
    var consentEpoch: Int { journal.preference.consentEpoch }

    init(directory: URL? = nil, defaults: UserDefaults = .standard,
         session: URLSession = .shared, environment: Environment? = nil, scheduleAutomatically: Bool = true) {
        self.defaults = defaults
        self.session = session
        self.environment = environment ?? .live
        self.scheduleAutomatically = scheduleAutomatically
        let support = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NotchSPI", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        fileURL = support.appendingPathComponent("telemetry-observation-v1.json")
        let enabled = defaults.object(forKey: Self.sharingKey) == nil ? true : defaults.bool(forKey: Self.sharingKey)
        if let data = try? Data(contentsOf: fileURL),
           let stored = try? Self.decoder.decode(ObservationJournal.self, from: data), stored.formatVersion == 1,
           stored.nextSequence >= 0, stored.nextSequence <= ObservationJournal.maximumCounter,
           stored.coveredThroughSequence >= 0, stored.coveredThroughSequence <= stored.nextSequence {
            journal = stored
            journal.resume(now: Date())
            if enabled != journal.preference.sharingEnabled { journal.setSharing(enabled, now: Date()) }
        } else {
            journal = .init(sharingEnabled: enabled, now: Date())
            if FileManager.default.fileExists(atPath: fileURL.path) { journal.gap("storage_failure") }
        }
        let legacy = support.appendingPathComponent("telemetry-v1.json")
        if FileManager.default.fileExists(atPath: legacy.path) {
            // Old queues have no atomic sequence journal. Preserve the uncertainty, never
            // relabel those entries as evidence of complete schema-2 observation.
            journal.gap("client_restart")
            try? FileManager.default.removeItem(at: legacy)
        }
        if !enabled { journal.queue.removeAll(); journal.openCaptures.removeAll(); journal.pendingCoverage = nil }
        persist()
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.journal.prepareShutdown()
                self?.persist()
            }
        }
        schedule(after: 1)
    }

    func record(_ original: ProductTelemetryEvent) {
        guard sharingEnabled else { return }
        guard original.consentEpoch == nil || original.consentEpoch == journal.preference.consentEpoch else { return }
        guard environment.config().enabled else {
            journal.gap("server_disabled")
            persist()
            return
        }
        var event = original
        let source = environment.source()
        event.sourceGroup = event.sourceGroup ?? source.group
        event.sourceMethod = event.sourceMethod ?? source.method
        event.operation = event.operation ?? "solve"
        if event.eventName == "capture_completed" {
            event.usableResult = event.usableResult ?? false
            event.completionKind = event.completionKind ?? (["stop_button", "user_toggled", "capture_hotkey"].contains(event.errorCode ?? "") ? "canceled" : "failed")
        }
        journal.append(event, now: Date())
        persist()
        if event.eventName == "capture_completed" || journal.queue.count >= 20 { flush() }
        else { schedule(after: 30) }
    }

    func flush() {
        guard uploadID == nil else { return }
        guard let token = environment.token() else { schedule(after: 30); return }
        let base = environment.baseURL()
        guard let observationURL = URL(string: base + "/v1/device-observation"),
              let eventURL = URL(string: base + "/v1/events/batch") else { return }
        let binding = Self.binding(base: base, token: token)
        journal.bind(binding, now: Date())
        journal.prune(now: Date())
        persist()
        if !sharingEnabled && !journal.preferencePending { return }
        let id = UUID()
        uploadID = id
        uploadTask = Task {
            defer {
                if uploadID == id { uploadID = nil; uploadTask = nil }
            }
            do {
                if journal.preferencePending {
                    let (data, response) = try await session.data(for: request(url: observationURL, token: token))
                    guard currentUpload(id, binding: binding) else { return }
                    guard (response as? HTTPURLResponse)?.statusCode == 200,
                          let remote = try? Self.decoder.decode(RemoteState.self, from: data) else { throw UploadFailure.response }
                    guard abs(remote.serverTime.timeIntervalSinceNow) <= 300 else {
                        journal.gap("invalid_time")
                        throw UploadFailure.clock
                    }
                    journal.reconcilePreference(remote.preference, now: Date())
                    defaults.set(journal.preference.sharingEnabled, forKey: Self.sharingKey)
                    if journal.preferencePending {
                        let body = try Self.encoder.encode(PreferenceBody(preference: journal.preference))
                        let (data, response) = try await session.data(for: request(url: observationURL, token: token, body: body))
                        guard currentUpload(id, binding: binding) else { return }
                        guard (response as? HTTPURLResponse)?.statusCode == 200,
                              let accepted = try? Self.decoder.decode(RemoteState.self, from: data),
                              let preference = accepted.preference,
                              preference.consentEpoch == journal.preference.consentEpoch,
                              preference.sharingEnabled == sharingEnabled else { throw UploadFailure.response }
                        journal.preference = preference
                        journal.preferencePending = false
                        journal.localPreferenceChange = false
                        journal.adoptRemotePreference = false
                    }
                    if remote.telemetryEnabled == false { journal.gap("server_disabled") }
                    persist()
                }
                guard currentUpload(id, binding: binding), sharingEnabled else { return }
                let limit = min(50, max(1, environment.config().maxBatchSize))
                let batch = Array(journal.queue.prefix(limit))
                if !batch.isEmpty {
                    let epoch = journal.preference.consentEpoch
                    let body = try Self.encoder.encode(Batch(events: batch))
                    let (data, response) = try await session.data(for: request(url: eventURL, token: token, body: body))
                    guard currentUpload(id, binding: binding), sharingEnabled,
                          journal.preference.consentEpoch == epoch else { return }
                    guard (response as? HTTPURLResponse)?.statusCode == 202,
                          let receipt = try? Self.decoder.decode(BatchReceipt.self, from: data),
                          receipt.accepted >= 0, receipt.duplicate >= 0, receipt.rejected >= 0 else { throw UploadFailure.response }
                    let acknowledged = receipt.accepted + receipt.duplicate + receipt.rejected
                    if acknowledged == batch.count {
                        journal.acknowledgeEvents(batch, rejected: receipt.rejected)
                        if receipt.rejected > 0 { journal.preferencePending = true }
                    } else if acknowledged == 0 {
                        journal.acknowledgeEvents(batch, rejected: batch.count)
                        journal.gap("server_disabled")
                    } else { throw UploadFailure.response }
                    persist()
                }
                if journal.queue.isEmpty, let coverage = journal.prepareCoverage(now: Date()) {
                    persist() // response loss reuses the exact id and interval after restart
                    let body = try Self.encoder.encode(CoverageBody(coverage: coverage))
                    let (data, response) = try await session.data(for: request(url: observationURL, token: token, body: body))
                    guard currentUpload(id, binding: binding), sharingEnabled else { return }
                    guard (response as? HTTPURLResponse)?.statusCode == 200,
                          let receipt = try? Self.decoder.decode(CoverageReceipt.self, from: data), receipt.accepted,
                          receipt.coverage.observationID == coverage.observationID,
                          receipt.coverage.consentEpoch == coverage.consentEpoch,
                          receipt.coverage.sequenceFrom == coverage.sequenceFrom,
                          receipt.coverage.sequenceTo == coverage.sequenceTo else { throw UploadFailure.response }
                    journal.acknowledgeCoverage(coverage)
                    persist()
                }
                retryIndex = 0
                schedule(after: journal.queue.isEmpty ? 30 : 0.1)
            } catch {
                guard currentUpload(id, binding: binding) else { return }
                persist()
                let delay = retryDelays[min(retryIndex, retryDelays.count - 1)]
                retryIndex = min(retryIndex + 1, retryDelays.count - 1)
                schedule(after: delay)
            }
        }
    }

    private func currentUpload(_ id: UUID, binding: String) -> Bool {
        guard !Task.isCancelled, uploadID == id, journal.scopeBinding == binding,
              let token = environment.token() else { return false }
        return Self.binding(base: environment.baseURL(), token: token) == binding
    }

    private static func binding(base: String, token: String) -> String {
        SHA256.hash(data: Data((base + "\0" + token).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func request(url: URL, token: String, body: Data? = nil) -> URLRequest {
        var value = URLRequest(url: url)
        value.httpMethod = body == nil ? "GET" : "POST"
        value.httpBody = body
        value.timeoutInterval = 8
        value.setValue("application/json", forHTTPHeaderField: "Content-Type")
        value.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        value.setValue(environment.appVersion(), forHTTPHeaderField: "X-App-Version")
        return value
    }

    private func schedule(after delay: TimeInterval) {
        guard scheduleAutomatically else { return }
        scheduled?.cancel()
        let work = DispatchWorkItem { [weak self] in Task { @MainActor in self?.flush() } }
        scheduled = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func persist() {
        do {
            try Self.encoder.encode(journal).write(to: fileURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch { journal.gap("storage_failure") }
    }

    nonisolated static func pruned(_ events: [ProductTelemetryEvent], now: Date = Date()) -> [ProductTelemetryEvent] {
        Array(events.filter { now.timeIntervalSince($0.occurredAt) <= 7 * 86_400 && $0.occurredAt.timeIntervalSince(now) <= 300 }.suffix(100))
    }

    private static let encoder: JSONEncoder = {
        let value = JSONEncoder()
        value.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.ISO8601Format(.init(includingFractionalSeconds: true)))
        }
        return value
    }()
    private static let decoder: JSONDecoder = {
        let value = JSONDecoder()
        value.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid observation timestamp")
            }
            return date
        }
        return value
    }()
}
