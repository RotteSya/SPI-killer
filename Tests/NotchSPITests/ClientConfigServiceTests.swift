import XCTest
@testable import NotchSPI

@MainActor
private final class ConfigAccountBox {
    var value: OfficialAPI.CaptureAccount?
    var date = Date(timeIntervalSince1970: 1_800_000_000)
}

@MainActor
final class ClientConfigServiceTests: XCTestCase {
    private func body(_ revision: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "schema_version": 1, "revision": revision,
            "objective_result_v1": ["variant": "objective_v1", "protocol": "objective_v1", "prompt_variant": "objective_v1"],
            "screen_query": ["capabilities": ["screen_query_v1"], "enabled_profiles": ["reading_practice"]],
            "telemetry": ["enabled": false, "max_batch_size": 50, "max_queue_age_days": 7]
        ])
    }

    func testAccountReplacementStartsNewRefreshAndLateResponseCannotReplaceIt() async throws {
        let suite = "notchspi.test.config." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        let oldReceived = expectation(description: "old request"), newReceived = expectation(description: "new request")
        var oldReply: CaptureHTTPReply?, newReply: CaptureHTTPReply?, requests = 0
        let server = try CaptureHTTPServer { request, reply in
            XCTAssertEqual(request.path, "/v1/client-config"); requests += 1
            if request.headers["authorization"] == "Bearer account-original" { oldReply = reply; oldReceived.fulfill() }
            else { XCTAssertEqual(request.headers["authorization"], "Bearer account-replacement"); newReply = reply; newReceived.fulfill() }
        }
        defer { server.stop() }
        let base = try await server.start(), owner = ConfigAccountBox()
        owner.value = .init(token: "account-original", baseURL: base)
        let service = ClientConfigService(defaults: defaults, account: { owner.value }, now: { owner.date }, session: session)
        let oldTask = try XCTUnwrap(service.refresh())
        await fulfillment(of: [oldReceived], timeout: 3)
        owner.value = .init(token: "account-replacement", baseURL: base, generation: 1)
        XCTAssertEqual(service.current.revision, "base")
        let newTask = try XCTUnwrap(service.refresh())
        await fulfillment(of: [newReceived], timeout: 3)
        try XCTUnwrap(oldReply).respond(type: "application/json", body: body("old"))
        await oldTask.value
        // Completing the cancelled task must not clear ownership of the new in-flight request.
        _ = service.refresh()
        try XCTUnwrap(newReply).respond(type: "application/json", body: body("replacement"))
        await newTask.value
        XCTAssertEqual(service.current.revision, "replacement")
        XCTAssertEqual(requests, 2)
        let saved = try XCTUnwrap(defaults.data(forKey: "clientConfig.v2.cache"))
        XCTAssertFalse(String(decoding: saved, as: UTF8.self).contains("account-replacement"))
        owner.value = nil
        XCTAssertEqual(service.current.revision, "base")
        XCTAssertNil(defaults.data(forKey: "clientConfig.v2.cache"))
    }

    func testServiceChangeInvalidatesMemoryAndCannotLoadOtherServicesDiskCache() async throws {
        let suite = "notchspi.test.config." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)), owner = ConfigAccountBox()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        let server = try CaptureHTTPServer { _, reply in reply.respond(type: "application/json", body: try! self.body("service-a")) }
        defer { server.stop() }
        owner.value = .init(token: "same-token", baseURL: try await server.start())
        let service = ClientConfigService(defaults: defaults, account: { owner.value }, now: { owner.date }, session: session)
        await service.refresh()?.value
        XCTAssertEqual(service.current.revision, "service-a")
        let saved = try XCTUnwrap(defaults.data(forKey: "clientConfig.v2.cache"))
        let restored = ClientConfigService(defaults: defaults, account: { owner.value }, now: { owner.date }, session: session)
        XCTAssertEqual(restored.current.revision, "service-a")
        let originalBase = try XCTUnwrap(owner.value).baseURL
        let otherAccount = ClientConfigService(defaults: defaults,
            account: { .init(token: "different-token", baseURL: originalBase) }, now: { owner.date }, session: session)
        XCTAssertEqual(otherAccount.current.revision, "base")
        defaults.set(saved, forKey: "clientConfig.v2.cache")
        owner.value = .init(token: "same-token", baseURL: "https://different.invalid", generation: 1)
        XCTAssertEqual(service.current.revision, "base")
        defaults.set(saved, forKey: "clientConfig.v2.cache")
        let different = ClientConfigService(defaults: defaults, account: { owner.value }, now: { owner.date }, session: session)
        XCTAssertEqual(different.current.revision, "base")
        XCTAssertNil(defaults.data(forKey: "clientConfig.v2.cache"))
    }

    func testConfigurationExpiresInMemoryAndFutureDatedCacheIsRejected() async throws {
        let suite = "notchspi.test.config." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)), owner = ConfigAccountBox()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        let server = try CaptureHTTPServer { _, reply in reply.respond(type: "application/json", body: try! self.body("fresh")) }
        defer { server.stop() }
        owner.value = .init(token: "expiry-token", baseURL: try await server.start())
        let service = ClientConfigService(defaults: defaults, account: { owner.value }, now: { owner.date }, session: session)
        await service.refresh()?.value
        XCTAssertEqual(service.current.revision, "fresh")
        let saved = try XCTUnwrap(defaults.data(forKey: "clientConfig.v2.cache")), fetchedAt = owner.date
        owner.date = fetchedAt.addingTimeInterval(24 * 60 * 60 + 1)
        XCTAssertEqual(service.current.revision, "base")
        defaults.set(saved, forKey: "clientConfig.v2.cache")
        owner.date = fetchedAt.addingTimeInterval(-1)
        let future = ClientConfigService(defaults: defaults, account: { owner.value }, now: { owner.date }, session: session)
        XCTAssertEqual(future.current.revision, "base")
        XCTAssertNil(defaults.data(forKey: "clientConfig.v2.cache"))
    }

    func testOldUnboundCacheIsDiscarded() throws {
        let suite = "notchspi.test.config." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let config = try JSONDecoder().decode(NotchClientConfig.self, from: body("unsafe-unbound"))
        struct OldCache: Encodable { let fetchedAt: Date; let config: NotchClientConfig }
        defaults.set(try JSONEncoder().encode(OldCache(fetchedAt: Date(), config: config)), forKey: "clientConfig.v1.cache")
        let service = ClientConfigService(defaults: defaults, account: { .init(token: "new-account", baseURL: "https://local.invalid") })
        XCTAssertEqual(service.current.revision, "base")
        XCTAssertNil(defaults.data(forKey: "clientConfig.v1.cache"))
    }

    func testOversizedConfigurationAndRedirectCannotPublishOrForwardCredentials() async throws {
        let suite = "notchspi.test.config." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)), owner = ConfigAccountBox()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        var redirected = 0, call = 0
        let target = try CaptureHTTPServer { _, reply in redirected += 1; reply.respond(type: "application/json", body: try! self.body("redirected")) }
        defer { target.stop() }
        let targetURL = try await target.start()
        let oversized = try body(String(repeating: "x", count: 70_000))
        let server = try CaptureHTTPServer { _, reply in
            call += 1
            if call == 1 { reply.respond(type: "application/json", body: oversized) }
            else { reply.start(status: 302, type: "application/json", extra: "Location: \(targetURL)/v1/client-config\r\n"); reply.finish() }
        }
        defer { server.stop() }
        owner.value = .init(token: "credential-must-stay-local", baseURL: try await server.start())
        let service = ClientConfigService(defaults: defaults, account: { owner.value }, session: session)
        await service.refresh()?.value
        XCTAssertEqual(service.current.revision, "base")
        await service.refresh()?.value
        XCTAssertEqual(service.current.revision, "base")
        XCTAssertEqual(redirected, 0)
        XCTAssertNil(defaults.data(forKey: "clientConfig.v2.cache"))
    }
}
