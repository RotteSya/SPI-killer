import AppKit
import Foundation

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

    var id: UUID { eventID }

    enum CodingKeys: String, CodingKey {
        case eventID = "event_id", captureID = "capture_id", occurredAt = "occurred_at"
        case eventName = "event_name", trigger, channel, mode, depth
        case contextCount = "context_count", questionKind = "question_kind"
        case resultState = "result_state", parserPath = "parser_path", errorCode = "error_code"
        case action, captureMs = "capture_ms", firstTokenMs = "first_token_ms", totalMs = "total_ms"
        case configRevision = "config_revision", variant
    }
}

@MainActor
final class ProductTelemetry {
    static let shared = ProductTelemetry()
    static let sharingKey = "telemetry.reliabilitySharingEnabled"
    static let noticeKey = "telemetry.noticeShownVersion"

    private struct Batch: Encodable { let schemaVersion = 1; let events: [ProductTelemetryEvent]
        enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", events }
    }
    private var queue: [ProductTelemetryEvent] = []
    private var uploading = false
    private var uploadTask: Task<Void, Never>?
    private var retryIndex = 0
    private var scheduled: DispatchWorkItem?
    private let retryDelays: [TimeInterval] = [60, 300, 1_800]
    private let fileURL: URL

    var sharingEnabled: Bool {
        get {
            let defaults = UserDefaults.standard
            return defaults.object(forKey: Self.sharingKey) == nil
                ? true : defaults.bool(forKey: Self.sharingKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.sharingKey)
            if !newValue {
                uploadTask?.cancel()
                uploadTask = nil
                uploading = false
                queue.removeAll()
                scheduled?.cancel()
                persist()
            }
        }
    }

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NotchSPI", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        fileURL = support.appendingPathComponent("telemetry-v1.json")
        if let data = try? Data(contentsOf: fileURL),
           let stored = try? Self.decoder.decode([ProductTelemetryEvent].self, from: data) {
            queue = Self.pruned(stored)
            persist()
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { _ in Task { @MainActor in ProductTelemetry.shared.flush() } }
        schedule(after: 1)
    }

    func record(_ event: ProductTelemetryEvent) {
        guard sharingEnabled, ClientConfigService.shared.current.telemetry.enabled else { return }
        queue = Self.pruned(queue + [event])
        persist()
        if event.eventName == "capture_completed" || queue.count >= 20 { flush() }
        else if queue.count == 1 { schedule(after: 30) }
    }

    func flush() {
        guard sharingEnabled, !uploading, !queue.isEmpty,
              ClientConfigService.shared.current.telemetry.enabled,
              let token = OfficialAPI.deviceToken,
              let url = URL(string: OfficialAPI.baseURL + "/v1/events/batch") else { return }
        let limit = min(50, max(1, ClientConfigService.shared.current.telemetry.maxBatchSize))
        let batch = Array(queue.prefix(limit))
        guard let body = try? Self.encoder.encode(Batch(events: batch)) else { return }
        uploading = true
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(OfficialAPI.appVersion, forHTTPHeaderField: "X-App-Version")
        uploadTask = Task {
            defer { uploading = false; uploadTask = nil }
            let success: Bool
            if let (_, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 202 { success = true }
            else { success = false }
            guard !Task.isCancelled, sharingEnabled else { return }
            if success {
                let ids = Set(batch.map(\.eventID))
                queue.removeAll { ids.contains($0.eventID) }
                retryIndex = 0
                persist()
                if !queue.isEmpty { schedule(after: 0.1) }
            } else {
                let delay = retryDelays[min(retryIndex, retryDelays.count - 1)]
                retryIndex = min(retryIndex + 1, retryDelays.count - 1)
                schedule(after: delay)
            }
        }
    }

    private func schedule(after delay: TimeInterval) {
        scheduled?.cancel()
        let work = DispatchWorkItem { Task { @MainActor in ProductTelemetry.shared.flush() } }
        scheduled = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func persist() {
        guard let data = try? Self.encoder.encode(queue) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    nonisolated static func pruned(
        _ events: [ProductTelemetryEvent], now: Date = Date()
    ) -> [ProductTelemetryEvent] {
        Array(events.filter { now.timeIntervalSince($0.occurredAt) <= 7 * 86_400 }.suffix(100))
    }

    private static let encoder: JSONEncoder = {
        let value = JSONEncoder(); value.dateEncodingStrategy = .iso8601; return value
    }()
    private static let decoder: JSONDecoder = {
        let value = JSONDecoder(); value.dateDecodingStrategy = .iso8601; return value
    }()
}
