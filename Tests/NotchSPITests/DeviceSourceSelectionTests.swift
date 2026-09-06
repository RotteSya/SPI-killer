import XCTest
@testable import NotchSPI

private final class SourceProtocol: URLProtocol, @unchecked Sendable {
    static var status = 200
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "source.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let request = request
        DispatchQueue.main.async {
            Self.requests.append(request)
            let status = Self.status
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
                guard let self, let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                               headerFields: ["Content-Type": "application/json"]) else { return }
                self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: Data("{\"accepted\":true}".utf8))
                self.client?.urlProtocolDidFinishLoading(self)
            }
        }
    }
    override func stopLoading() {}
}

@MainActor
final class DeviceSourceSelectionTests: XCTestCase {
    private func fixture(_ body: (UserDefaults, URLSession) async throws -> Void) async throws {
        let suite = "source-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [SourceProtocol.self]
        let session = URLSession(configuration: configuration)
        SourceProtocol.status = 200; SourceProtocol.requests = []
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        try await body(defaults, session)
    }
    private var environment: DeviceSourceSelection.Environment {
        .init(token: { "dev_source_secret" }, baseURL: { "https://source.invalid/api" })
    }

    func testSkippingPersistsOnlyLocalDismissalAndSendsNothing() async throws {
        try await fixture { defaults, session in
            let source = DeviceSourceSelection(defaults: defaults, session: session, environment: environment, scheduleAutomatically: false)
            XCTAssertTrue(source.choose(nil)); await source.flush()
            let reopened = DeviceSourceSelection(defaults: defaults, session: session, environment: environment, scheduleAutomatically: false)
            XCTAssertEqual(reopened.record?.state, .skipped); await reopened.flush()
            XCTAssertFalse(reopened.choose(.spi)); XCTAssertTrue(SourceProtocol.requests.isEmpty)
            XCTAssertEqual(reopened.telemetrySource.group, "unknown")
            XCTAssertFalse(String(decoding: try XCTUnwrap(defaults.data(forKey: DeviceSourceSelection.storageKey)), as: UTF8.self).contains("dev_source_secret"))
        }
    }

    func testConcurrentSyncHasOneRequestAndConfirmedIdentitySurvivesRestart() async throws {
        try await fixture { defaults, session in
            let source = DeviceSourceSelection(defaults: defaults, session: session, environment: environment, scheduleAutomatically: false)
            XCTAssertTrue(source.choose(.readingPractice)); XCTAssertEqual(source.telemetrySource.method, "unknown")
            async let first: Void = source.flush(); async let second: Void = source.flush()
            _ = await (first, second)
            XCTAssertEqual(SourceProtocol.requests.count, 1)
            XCTAssertEqual(SourceProtocol.requests[0].url?.path, "/api/v1/device-source")
            XCTAssertEqual(SourceProtocol.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer dev_source_secret")
            XCTAssertEqual(source.telemetrySource.group, "reading_practice_entry"); XCTAssertEqual(source.telemetrySource.method, "self_reported")
            let reopened = DeviceSourceSelection(defaults: defaults, session: session, environment: environment, scheduleAutomatically: false)
            await reopened.flush(); XCTAssertEqual(SourceProtocol.requests.count, 1); XCTAssertEqual(reopened.record?.state, .confirmed)
            XCTAssertFalse(reopened.choose(.spi))
        }
    }

    func testRegistrationCanFinishAfterSelectionAndAuthFailureKeepsPendingChoice() async throws {
        try await fixture { defaults, session in
            var token: String?
            let env = DeviceSourceSelection.Environment(token: { token }, baseURL: { "https://source.invalid" })
            let source = DeviceSourceSelection(defaults: defaults, session: session, environment: env, scheduleAutomatically: false)
            XCTAssertTrue(source.choose(.spi)); await source.flush(); XCTAssertTrue(SourceProtocol.requests.isEmpty)
            token = "dev_source_secret"; SourceProtocol.status = 401; await source.flush()
            XCTAssertEqual(token, "dev_source_secret"); XCTAssertEqual(source.record?.state, .pending)
            let reopened = DeviceSourceSelection(defaults: defaults, session: session, environment: env, scheduleAutomatically: false)
            SourceProtocol.status = 200; await reopened.flush()
            XCTAssertEqual(reopened.record?.state, .confirmed); XCTAssertEqual(SourceProtocol.requests.count, 2)
        }
    }

    func testInFlightResponseForChangedAccountCannotConfirmOrTransferTheChoice() async throws {
        try await fixture { defaults, session in
            var token = "dev_original"
            let source = DeviceSourceSelection(defaults: defaults, session: session,
                environment: .init(token: { token }, baseURL: { "https://source.invalid" }), scheduleAutomatically: false)
            XCTAssertTrue(source.choose(.direct))
            let work = Task { await source.flush() }
            let deadline = Date().addingTimeInterval(3)
            while SourceProtocol.requests.isEmpty && Date() < deadline { try await Task.sleep(nanoseconds: 1_000_000) }
            XCTAssertFalse(SourceProtocol.requests.isEmpty)
            token = "dev_replacement"; await work.value
            XCTAssertEqual(source.record?.state, .pending); XCTAssertEqual(source.telemetrySource.group, "unknown")
            await source.flush(); XCTAssertEqual(SourceProtocol.requests.count, 1)
        }
    }

    func testServerConflictStopsRetriesAndDoesNotAssertUnconfirmedAttribution() async throws {
        try await fixture { defaults, session in
            let source = DeviceSourceSelection(defaults: defaults, session: session, environment: environment, scheduleAutomatically: false)
            XCTAssertTrue(source.choose(.direct)); SourceProtocol.status = 409; await source.flush(); await source.flush()
            XCTAssertEqual(source.record?.state, .conflict); XCTAssertEqual(SourceProtocol.requests.count, 1)
            XCTAssertEqual(source.telemetrySource.group, "unknown")
        }
    }

    func testRequestContainsOnlyExplicitSourceAndKeepsCredentialOutOfURLAndBody() throws {
        let request = DeviceSourceSelection.request(base: "https://source.invalid/api", token: "dev_private", group: .spi)
        XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.timeoutInterval, 8)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String], ["source_group": "spi_entry"])
        XCTAssertFalse(request.url!.absoluteString.contains("dev_private"))
    }

    func testMalformedConfirmedRecordWithoutAnAccountBindingCannotLabelTelemetry() async throws {
        try await fixture { defaults, session in
            let malformed = DeviceSourceSelection.Record(version: 1, id: UUID(), group: .spi,
                selectedAt: Date(), binding: nil, state: .confirmed)
            defaults.set(try JSONEncoder().encode(malformed), forKey: DeviceSourceSelection.storageKey)
            let source = DeviceSourceSelection(defaults: defaults, session: session,
                environment: .init(token: { nil }, baseURL: { "https://source.invalid" }), scheduleAutomatically: false)
            XCTAssertNil(source.record); XCTAssertEqual(source.telemetrySource.group, "unknown")
            await source.flush(); XCTAssertTrue(SourceProtocol.requests.isEmpty)
        }
    }
}
