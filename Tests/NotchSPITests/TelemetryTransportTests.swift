import XCTest
@testable import NotchSPI

private final class TelemetryTransportState: @unchecked Sendable {
    private let lock = NSLock()
    private var preference: [String: Any]?
    private var received: [[String: Any]] = []
    private var preferences: [[String: Any]] = []
    var events: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return received }
    var preferenceUpdates: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return preferences }

    func respond(_ request: URLRequest) -> (Data, TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        let data: Data
        if let body = request.httpBody { data = body }
        else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var value = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                value.append(contentsOf: buffer.prefix(count))
            }
            data = value
        } else { data = Data() }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        var result: [String: Any]
        var delay = 0.01
        if request.url?.path == "/v1/events/batch" {
            let events = body["events"] as? [[String: Any]] ?? []
            let first = received.isEmpty
            received.append(contentsOf: events)
            result = ["accepted": events.count, "duplicate": 0, "rejected": 0]
            delay = first ? 0.5 : 0.2
        } else if let coverage = body["coverage"] as? [String: Any] {
            result = ["accepted": true, "coverage": coverage]
        } else {
            if let changed = body["preference"] as? [String: Any] {
                preference = changed
                preferences.append(changed)
            }
            result = ["server_time": Date().ISO8601Format(.init(includingFractionalSeconds: true)),
                      "preference": preference ?? NSNull(), "telemetry_enabled": true, "accepted": true]
        }
        return ((try? JSONSerialization.data(withJSONObject: result)) ?? Data(), delay)
    }
}

private final class TelemetryFixtureProtocol: URLProtocol, @unchecked Sendable {
    static var state = TelemetryTransportState()
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "telemetry.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (data, delay) = Self.state.respond(request)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let stopped = self.stopped; self.lock.unlock()
            guard !stopped, let url = self.request.url,
                  let response = HTTPURLResponse(url: url, statusCode: url.path == "/v1/events/batch" ? 202 : 200,
                                                 httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else { return }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: data)
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { lock.lock(); stopped = true; lock.unlock() }
}

@MainActor
final class TelemetryTransportTests: XCTestCase {
    private func event(id: UUID, epoch: Int? = nil) -> ProductTelemetryEvent {
        .init(eventID: id, captureID: UUID(), occurredAt: Date(), eventName: "capture_started",
              trigger: "capture_hotkey", channel: "official", mode: "tutor", depth: "brief", contextCount: 0,
              questionKind: nil, resultState: nil, parserPath: nil, errorCode: nil, action: nil,
              captureMs: nil, firstTokenMs: nil, totalMs: nil, configRevision: "test", variant: "control", consentEpoch: epoch)
    }

    private func eventually(_ message: String, _ predicate: () -> Bool) async throws {
        for _ in 0..<150 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail(message)
    }

    func testCancellationAndReenablePreserveTheNewUploadAndEraseOldEvents() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("telemetry-test-" + UUID().uuidString)
        let suite = "telemetry-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TelemetryFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        let state = TelemetryTransportState()
        TelemetryFixtureProtocol.state = state
        defer {
            session.invalidateAndCancel()
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        let client = ProductTelemetry(directory: directory, defaults: defaults, session: session,
            environment: .init(token: { "dev_transport" }, baseURL: { "https://telemetry.invalid" }, appVersion: { "2.12" },
                               config: { .init(enabled: true, maxBatchSize: 50, maxQueueAgeDays: 7) }), scheduleAutomatically: false)
        let first = UUID(), second = UUID(), stale = UUID()
        client.record(event(id: first)); client.flush()
        try await eventually("first upload did not start") { state.events.contains { $0["event_id"] as? String == first.uuidString } }
        client.sharingEnabled = false
        client.sharingEnabled = true
        client.record(event(id: stale, epoch: 0))
        client.record(event(id: second, epoch: client.consentEpoch))
        client.flush()
        try await eventually("new consent version was not uploaded") { state.events.contains { $0["event_id"] as? String == second.uuidString } }
        try await Task.sleep(nanoseconds: 350_000_000)
        let file = directory.appendingPathComponent("telemetry-observation-v1.json")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual((object["queue"] as? [Any])?.count, 0, "old task completion must not invalidate the new upload")
        XCTAssertFalse(state.events.contains { $0["event_id"] as? String == stale.uuidString })
        XCTAssertEqual(state.events.filter { $0["event_id"] as? String == first.uuidString }.count, 1)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        let before = state.events.count
        client.sharingEnabled = false
        client.record(event(id: UUID()))
        client.flush()
        try await eventually("opt-out preference was not synchronized") { state.preferenceUpdates.last?["sharing_enabled"] as? Bool == false }
        XCTAssertEqual(state.events.count, before, "opt-out synchronizes service preference only")
        let disabledFile = String(decoding: try Data(contentsOf: file), as: UTF8.self)
        XCTAssertFalse(disabledFile.lowercased().contains(second.uuidString.lowercased()))
    }
}
