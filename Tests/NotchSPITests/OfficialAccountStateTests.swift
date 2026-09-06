import XCTest
import Security
@testable import NotchSPI

private final class AccountBaseBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = OfficialAPI.defaultBaseURL
    var value: String {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

@MainActor
private final class AccountFixture {
    let suite = "notchspi.test.account." + UUID().uuidString
    let service = "com.rottesya.notchspi.test.account." + UUID().uuidString
    let base = AccountBaseBox()
    let session = URLSession(configuration: .ephemeral)
    let defaults: UserDefaults
    let secrets: KeychainStore.Access
    let state: OfficialAccountState
    init(wrap: ((KeychainStore.Access) -> KeychainStore.Access)? = nil) {
        defaults = UserDefaults(suiteName: suite)!
        secrets = .system(service: service)
        let access = wrap?(secrets) ?? secrets
        state = OfficialAccountState(defaults: defaults, secrets: access, baseURL: { [base] in base.value })
    }
    var environment: OfficialAPI.AccountEnvironment { .init(state: state, session: session) }
    func seed(_ token: String = "dev_account_original_123456", balance: Int = 80, version: String = "8") {
        XCTAssertTrue(state.replaceCredential(token))
        XCTAssertTrue(state.applyBalance(balance, version: version))
        state.setValue(true, for: "cliEnabled")
        state.setValue(20, for: "totalQuestions")
    }
    func close() {
        session.invalidateAndCancel()
        XCTAssertTrue(secrets.write(nil, "official.registrationAttempt"))
        XCTAssertTrue(secrets.write(nil, "official.deviceToken"))
        defaults.removePersistentDomain(forName: suite)
    }
}

@MainActor
final class OfficialAccountStateTests: XCTestCase {
    func testUsageAfterRefreshDoesNotCountTheSameSettlementTwice() throws {
        let f = AccountFixture(); defer { f.close() }
        f.seed()
        let ticket = try f.state.prepareRefresh()
        let response = try JSONDecoder().decode(OfficialAccountResponse.self,
            from: body(balance: 79, version: "9", total: 21))
        try f.state.acceptRefresh(response, ticket: ticket)
        let receipt = OfficialUsageReceipt(inputTokens: 10, outputTokens: 2, questionsCharged: 1,
            balanceQuestions: 79, captureID: UUID(), settlementStatus: "settled", balanceVersion: "9", operation: "solve",
            accountTotals: .init(questions: 21, inputTokens: 210, outputTokens: 42))
        let capture = OfficialAPI.CaptureEnvironment.connected(to: f.environment)
        capture.receiveUsage(receipt)
        capture.receiveUsage(receipt)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 21)
        XCTAssertEqual(f.state.value("totalInputTokens") as? Int, 210)
        XCTAssertEqual(f.state.value("totalOutputTokens") as? Int, 42)
    }

    private func body(balance: Int = 30, version: String = "1", token: String? = nil, cli: Bool = false, total: Int = 3) -> Data {
        var value: [String: Any] = ["balance_questions": balance, "balance_version": version,
            "cli_enabled": cli, "total_questions": total, "total_input_tokens": total * 10, "total_output_tokens": total * 2]
        if let token { value["device_token"] = token }
        return try! JSONSerialization.data(withJSONObject: value)
    }

    func testReorderedReceiptsAndAuxiliaryUsageUseWholeCumulativeSnapshots() throws {
        let f = AccountFixture(); defer { f.close() }
        f.seed()
        let refresh = try f.state.prepareRefresh()
        let capture = OfficialAPI.CaptureEnvironment.connected(to: f.environment)
        let first = OfficialUsageReceipt(inputTokens: 10, outputTokens: 2, questionsCharged: 1,
            balanceQuestions: 79, captureID: UUID(), settlementStatus: "settled", balanceVersion: "9", operation: "solve",
            accountTotals: .init(questions: 21, inputTokens: 210, outputTokens: 42))
        let second = OfficialUsageReceipt(inputTokens: 20, outputTokens: 4, questionsCharged: 1,
            balanceQuestions: 78, captureID: UUID(), settlementStatus: "settled", balanceVersion: "11", operation: "solve",
            accountTotals: .init(questions: 22, inputTokens: 230, outputTokens: 46))
        capture.receiveUsage(second)
        capture.receiveUsage(first)
        capture.receiveUsage(second)
        try f.state.acceptRefresh(JSONDecoder().decode(OfficialAccountResponse.self,
            from: body(balance: 79, version: "9", total: 21)), ticket: refresh)
        let auxiliary = OfficialUsageReceipt(inputTokens: 500, outputTokens: 80, questionsCharged: 0,
            balanceQuestions: 78, captureID: UUID(), settlementStatus: "not_required", balanceVersion: "11", operation: "explain",
            accountTotals: second.accountTotals)
        capture.receiveUsage(auxiliary)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 22)
        XCTAssertEqual(f.state.value("totalInputTokens") as? Int, 230)
        XCTAssertEqual(f.state.value("totalOutputTokens") as? Int, 46)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 78)
        XCTAssertEqual(f.state.value("balanceVersion") as? String, "11")
        f.seed("dev_replacement_totals_123456", balance: 700, version: "70")
        capture.receiveUsage(second)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 20)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 700)
    }

    func testStatusSnapshotUpdatesAllCountersWithoutAddingTheCaptureAgain() throws {
        let f = AccountFixture(); defer { f.close() }
        f.seed()
        let status = SettlementSnapshot(captureID: UUID(), operation: "solve", terminalState: "usable",
            settlementStatus: "settled", questionsCharged: 1, usableResult: true,
            balanceQuestions: 78, heldQuestions: 0, balanceVersion: "11", canRetry: false, canRecover: true,
            accountTotals: .init(questions: 22, inputTokens: 230, outputTokens: 46))
        let capture = OfficialAPI.CaptureEnvironment.connected(to: f.environment)
        capture.receiveSettlement(status)
        capture.receiveSettlement(status)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 22)
        XCTAssertEqual(f.state.value("totalInputTokens") as? Int, 230)
        XCTAssertEqual(f.state.value("totalOutputTokens") as? Int, 46)
        for (version, totals) in [(nil, OfficialAccountTotals(questions: 25, inputTokens: 250, outputTokens: 50)),
                                  ("12", OfficialAccountTotals(questions: -1, inputTokens: 250, outputTokens: 50))] {
            XCTAssertFalse(f.state.applyBalance(900, version: version, totals: totals))
        }
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 78)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 22)
    }

    func testLegacyUsageRefreshesTheBoundAccountWithoutOptimisticCounters() async throws {
        let f = AccountFixture(); defer { f.close() }
        let entered = expectation(description: "legacy usage account reconciliation")
        var reply: CaptureHTTPReply?
        let server = try await peer(f) { request, response in
            XCTAssertEqual(request.path, "/v1/account")
            XCTAssertEqual(request.headers["authorization"], "Bearer dev_account_original_123456")
            reply = response; entered.fulfill()
        }
        defer { server.stop() }
        f.seed()
        let capture = OfficialAPI.CaptureEnvironment.connected(to: f.environment)
        capture.receiveUsage(.init(inputTokens: 10, outputTokens: 2, questionsCharged: 1,
            balanceQuestions: 79, captureID: nil, settlementStatus: nil, balanceVersion: "9", operation: nil))
        await fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 79)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 20, "No per-call increment before the authoritative GET")
        reply?.respond(type: "application/json", body: body(balance: 79, version: "9", total: 21))
        for _ in 0..<200 where f.state.value("totalQuestions") as? Int != 21 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 21)
        XCTAssertEqual(f.state.value("totalInputTokens") as? Int, 210)
        XCTAssertEqual(f.state.value("totalOutputTokens") as? Int, 42)
    }

    func testLegacyRefreshCannotStartForAReplacementAccount() async throws {
        let f = AccountFixture(); defer { f.close() }
        var requests = 0
        let server = try await peer(f) { _, response in
            requests += 1; response.respond(type: "application/json", body: self.body())
        }
        defer { server.stop() }
        f.seed()
        let owner = try XCTUnwrap(f.state.account)
        f.seed("dev_new_legacy_owner_123456", balance: 700, version: "70")
        assertFailure(await OfficialAPI.refreshAccount(environment: f.environment, expectedAccount: owner), code: "account_changed")
        XCTAssertEqual(requests, 0)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 700)
    }

    func testRetainedCaptureEnvironmentCannotAdoptAnAccountBeforeDispatch() async throws {
        let f = AccountFixture(); defer { f.close() }
        var requests = 0
        let server = try await peer(f) { _, response in requests += 1; response.respond(status: 500, body: Data()) }
        defer { server.stop() }
        let unregistered = OfficialAPI.CaptureEnvironment.connected(to: f.environment)
        f.seed()
        let owner = try XCTUnwrap(f.state.account)
        let retained = OfficialAPI.CaptureEnvironment.connected(to: f.environment)
        XCTAssertNil(unregistered.account())
        XCTAssertEqual(retained.account(), owner)
        f.seed("dev_another_parent_owner_123456")
        let explicitlyBound = OfficialAPI.CaptureEnvironment.connected(to: f.environment, expectedAccount: owner)
        for environment in [retained, explicitlyBound] {
            XCTAssertNil(environment.account())
            let done = expectation(description: "reject stale retained parent")
            let task = OfficialAPI.run(imagePaths: [], prompt: .init(system: "", task: ""), environment: environment,
                onDelta: { _ in XCTFail("Stale environment must not deliver content") },
                onDone: { success, _ in XCTAssertFalse(success); done.fulfill() })
            XCTAssertNil(task)
            await fulfillment(of: [done], timeout: 5)
        }
        XCTAssertEqual(requests, 0)
    }

    func testRetainedParentStatusUsesItsCredentialAndCannotCrossAnAccountChange() async throws {
        for replace in [false, true] {
            let f = AccountFixture(); defer { f.close() }
            let id = UUID(), entered = expectation(description: "parent status request")
            var reply: CaptureHTTPReply?; var requests = 0
            let server = try await peer(f) { request, response in
                requests += 1
                XCTAssertEqual(request.path, "/v1/captures/" + id.uuidString.lowercased() + "/status")
                XCTAssertEqual(request.headers["authorization"], "Bearer dev_account_original_123456")
                reply = response; entered.fulfill()
            }
            defer { server.stop() }
            f.seed()
            let owner = try XCTUnwrap(f.state.account)
            let task = Task { await OfficialAPI.reconcileCaptureStatus(id, account: owner, environment: f.environment) }
            await fulfillment(of: [entered], timeout: 5)
            if replace { f.seed("dev_new_status_owner_123456", balance: 700, version: "70") }
            let json: [String: Any] = ["capture_id": id.uuidString, "operation": "solve", "terminal_state": "usable",
                "settlement_status": "settled", "questions_charged": 1, "usable_result": true,
                "balance_questions": 79, "held_questions": 0, "balance_version": "9", "can_retry": false, "can_recover": true,
                "account_totals": ["questions": 21, "input_tokens": 210, "output_tokens": 42]]
            reply?.respond(type: "application/json", body: try JSONSerialization.data(withJSONObject: json))
            let status = await task.value
            XCTAssertEqual(status?.isTerminal, replace ? nil : true)
            XCTAssertEqual(f.state.value("balanceQuestions") as? Int, replace ? 700 : 79)
            XCTAssertEqual(f.state.value("totalQuestions") as? Int, replace ? 20 : 21)
            if !replace { f.seed("dev_after_status_123456", balance: 700, version: "70") }
            let stale = await OfficialAPI.reconcileCaptureStatus(id, account: owner, environment: f.environment)
            XCTAssertNil(stale)
            XCTAssertEqual(requests, 1, "A stale parent must not issue another status GET")
        }
    }
    private func peer(_ fixture: AccountFixture,
                      handler: @escaping @MainActor (CaptureHTTPRequest, CaptureHTTPReply) -> Void) async throws -> CaptureHTTPServer {
        let server = try CaptureHTTPServer(handler: handler)
        fixture.base.value = try await server.start()
        return server
    }
    private func assertFailure<T>(_ result: Result<T, OfficialAPIError>, code: String? = nil,
                                  file: StaticString = #filePath, line: UInt = #line) {
        guard case .failure(let error) = result else { XCTFail("Expected a failed operation", file: file, line: line); return }
        if let code { XCTAssertEqual(error.code, code, file: file, line: line) }
    }

    func testConcurrentRegistrationUsesOneHTTPAttemptAndPersistsInRealIsolatedKeychain() async throws {
        let f = AccountFixture(); defer { f.close() }
        let entered = expectation(description: "registration request")
        var requests: [CaptureHTTPRequest] = []; var reply: CaptureHTTPReply?
        let server = try await peer(f) { request, response in requests.append(request); reply = response; entered.fulfill() }
        defer { server.stop() }
        let tasks = (0..<8).map { _ in Task { await OfficialAPI.registerIfNeeded(environment: f.environment) } }
        await fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].path, "/v1/devices")
        let requestBody = try XCTUnwrap(JSONSerialization.jsonObject(with: requests[0].body) as? [String: Any])
        let attempt = try XCTUnwrap(requestBody["registration_attempt_id"] as? String)
        XCTAssertEqual(attempt.count, 43)
        XCTAssertEqual(f.secrets.read("official.registrationAttempt"), .value(attempt))
        XCTAssertEqual(f.secrets.read("official.deviceToken"), .missing)
        reply?.respond(type: "application/json", body: body(token: "dev_registered_persisted_123456"))
        for task in tasks {
            let result = try await task.value.get()
            XCTAssertEqual(result, "dev_registered_persisted_123456")
        }
        XCTAssertEqual(f.secrets.read("official.deviceToken"), .value("dev_registered_persisted_123456"))
        XCTAssertEqual(f.secrets.read("official.registrationAttempt"), .missing)
        XCTAssertNil(f.defaults.object(forKey: "official.deviceToken"))
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 30)
        let existing = try await OfficialAPI.registerIfNeeded(environment: f.environment).get()
        XCTAssertEqual(existing, "dev_registered_persisted_123456")
        XCTAssertEqual(requests.count, 1)
    }

    func testLostRegistrationResponseRetriesTheSavedCredential() async throws {
        let f = AccountFixture(); defer { f.close() }
        var attempts: [String] = []
        let server = try await peer(f) { request, response in
            let object = try! JSONSerialization.jsonObject(with: request.body) as! [String: Any]
            attempts.append(object["registration_attempt_id"] as! String)
            if attempts.count == 1 { response.truncated() }
            else { response.respond(type: "application/json", body: self.body(token: "dev_response_lost_123456")) }
        }
        defer { server.stop() }
        assertFailure(await OfficialAPI.registerIfNeeded(environment: f.environment))
        XCTAssertEqual(f.secrets.read("official.deviceToken"), .missing)
        _ = try await OfficialAPI.registerIfNeeded(environment: f.environment).get()
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts[0], attempts[1])
    }

    func testRegistrationCannotOverwriteAReplacementOrAnExplicitResetOrAnotherService() async throws {
        for change in ["replace", "reset", "service"] {
            let f = AccountFixture(); defer { f.close() }
            let entered = expectation(description: change); var reply: CaptureHTTPReply?
            let server = try await peer(f) { _, response in reply = response; entered.fulfill() }
            defer { server.stop() }
            let task = Task { await OfficialAPI.registerIfNeeded(environment: f.environment) }
            await fulfillment(of: [entered], timeout: 5)
            switch change {
            case "replace": f.seed("dev_replacement_123456", balance: 900, version: "90")
            case "reset": XCTAssertTrue(f.state.resetCredential())
            default: f.base.value = "http://127.0.0.1:1"
            }
            reply?.respond(type: "application/json", body: body(token: "dev_late_registration_123456"))
            assertFailure(await task.value, code: "account_changed")
            XCTAssertNotEqual(f.secrets.read("official.deviceToken"), .value("dev_late_registration_123456"))
            if change == "replace" { XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 900) }
        }
    }

    func testLateAccountSuccessAnd401CannotMutateANewCredentialOrHost() async throws {
        for code in [200, 401] {
            for change in ["credential", "host"] {
                let f = AccountFixture(); defer { f.close() }
                let entered = expectation(description: "account request"); var reply: CaptureHTTPReply?
                let server = try await peer(f) { request, response in
                    XCTAssertEqual(request.headers["authorization"], "Bearer dev_account_original_123456")
                    reply = response; entered.fulfill()
                }
                defer { server.stop() }
                f.seed()
                let task = Task { await OfficialAPI.refreshAccount(environment: f.environment) }
                await fulfillment(of: [entered], timeout: 5)
                if change == "host" { f.base.value = "http://127.0.0.1:1" }
                else { XCTAssertTrue(f.state.replaceCredential("dev_new_account_123456")) }
                XCTAssertTrue(f.state.applyBalance(700, version: "70"))
                f.state.setValue(false, for: "credentialRejected")
                f.state.setValue(91, for: "totalQuestions")
                reply?.respond(status: code, type: "application/json", body: body(balance: 1, version: "999", total: 900))
                assertFailure(await task.value, code: "account_changed")
                XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 700)
                XCTAssertEqual(f.state.value("totalQuestions") as? Int, 91)
                XCTAssertEqual(f.state.value("credentialRejected") as? Bool, false)
            }
        }
    }

    func testAccountRefreshCommitsFieldsTogetherAndRejectsOlderVersionsAndResponses() async throws {
        let f = AccountFixture(); defer { f.close() }
        var replies: [CaptureHTTPReply] = []
        var nextEntered: XCTestExpectation?
        let server = try await peer(f) { _, response in replies.append(response); nextEntered?.fulfill() }
        defer { server.stop() }
        f.seed()
        nextEntered = expectation(description: "old refresh")
        let old = Task { await OfficialAPI.refreshAccount(environment: f.environment) }
        await fulfillment(of: [nextEntered!], timeout: 5)
        nextEntered = expectation(description: "new refresh")
        let new = Task { await OfficialAPI.refreshAccount(environment: f.environment) }
        await fulfillment(of: [nextEntered!], timeout: 5)
        replies[1].respond(type: "application/json", body: body(balance: 72, version: "9", cli: false, total: 25))
        _ = try await new.value.get()
        replies[0].respond(type: "application/json", body: body(balance: 72, version: "9", cli: true, total: 24))
        _ = try await old.value.get()
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 72)
        XCTAssertEqual(f.state.value("cliEnabled") as? Bool, false)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 25)
        let ticket = try f.state.prepareRefresh()
        try f.state.acceptRefresh(JSONDecoder().decode(OfficialAccountResponse.self, from: body(balance: 80, version: "8", cli: true, total: 1)), ticket: ticket)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 72)
        XCTAssertEqual(f.state.value("cliEnabled") as? Bool, false)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 25)
    }

    func testAnOlder401DoesNotRejectACredentialConfirmedByANewerRefresh() throws {
        let f = AccountFixture(); defer { f.close() }
        f.seed()
        let old = try f.state.prepareRefresh(), new = try f.state.prepareRefresh()
        try f.state.acceptRefresh(JSONDecoder().decode(OfficialAccountResponse.self, from: body(balance: 72, version: "9")), ticket: new)
        f.state.rejectCredential(for: old.account, refreshSequence: old.sequence)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 72)
        XCTAssertEqual(f.state.value("credentialRejected") as? Bool, false)
        f.state.rejectCredential(for: new.account, refreshSequence: new.sequence)
        XCTAssertNil(f.state.value("balanceQuestions"))
        XCTAssertEqual(f.state.value("credentialRejected") as? Bool, true)
        XCTAssertEqual(f.state.token, "dev_account_original_123456")
    }

    func testAcceptedAuthoritativeTotalsCanCorrectAnInflatedLocalMirror() throws {
        let f = AccountFixture(); defer { f.close() }
        f.seed()
        f.state.setValue(9_000, for: "totalInputTokens")
        let ticket = try f.state.prepareRefresh()
        try f.state.acceptRefresh(JSONDecoder().decode(OfficialAccountResponse.self, from: body(balance: 80, version: "8", total: 20)), ticket: ticket)
        XCTAssertEqual(f.state.value("totalInputTokens") as? Int, 200)
        let legacy = try JSONDecoder().decode(OfficialAccountResponse.self, from: Data(#"{"balance_questions":1,"cli_enabled":false,"total_questions":1}"#.utf8))
        try f.state.acceptRefresh(legacy, ticket: f.state.prepareRefresh())
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 80)
        XCTAssertEqual(f.state.value("totalQuestions") as? Int, 20)
    }

    func testMalformedOversizedAndNonJSONAccountRepliesDoNotPartiallyApply() async throws {
        let f = AccountFixture(); defer { f.close() }
        var payload = Data(); var contentType = "application/json"
        let server = try await peer(f) { _, response in response.respond(type: contentType, body: payload) }
        defer { server.stop() }
        f.seed()
        let malformed = [
            #"{"balance_questions":false,"balance_version":"99"}"#,
            #"{"balance_questions":-1,"balance_version":"99"}"#,
            #"{"balance_questions":1.5,"balance_version":"99"}"#,
            #"{"balance_questions":1,"balance_version":"bad"}"#,
            #"{"balance_questions":1,"balance_version":"99","total_questions":-1}"#,
            #"{"balance_questions":1,"balance_version":"99","cli_enabled":1}"#,
            #"{"balance_version":"99"}"#,
            String(repeating: "x", count: 65_537),
        ]
        for text in malformed {
            payload = Data(text.utf8)
            assertFailure(await OfficialAPI.refreshAccount(environment: f.environment))
            XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 80)
            XCTAssertEqual(f.state.value("cliEnabled") as? Bool, true)
            XCTAssertEqual(f.state.value("totalQuestions") as? Int, 20)
        }
        contentType = "text/html"; payload = body(balance: 1, version: "99")
        assertFailure(await OfficialAPI.refreshAccount(environment: f.environment))
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 80)
    }

    func testCancelledRefreshAndRedirectCannotApplyOrForwardCredentials() async throws {
        let f = AccountFixture(); defer { f.close() }
        var redirected = 0
        let target = try CaptureHTTPServer { _, response in redirected += 1; response.respond(type: "application/json", body: self.body()) }
        let targetBase = try await target.start(); defer { target.stop() }
        var redirect = false; var reply: CaptureHTTPReply?
        let entered = expectation(description: "cancel refresh")
        let server = try await peer(f) { _, response in
            if redirect {
                response.start(status: 302, type: "application/json", extra: "Location: \(targetBase)/v1/account\r\n")
                response.send(Data("{}".utf8)); response.finish()
            } else { reply = response; entered.fulfill() }
        }
        defer { server.stop() }
        f.seed()
        let task = Task { await OfficialAPI.refreshAccount(environment: f.environment) }
        await fulfillment(of: [entered], timeout: 5)
        task.cancel()
        reply?.respond(type: "application/json", body: body(balance: 1, version: "99"))
        assertFailure(await task.value)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 80)
        redirect = true
        assertFailure(await OfficialAPI.refreshAccount(environment: f.environment))
        XCTAssertEqual(redirected, 0)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 80)
    }

    func testUnavailableKeychainNeverAuthorizesRegistrationOrOverwritesRecovery() async throws {
        for blockedAccount in ["official.deviceToken", "official.registrationAttempt"] {
            var writes = 0
            let f = AccountFixture { real in .init(read: { $0 == blockedAccount ? .unavailable(errSecInteractionNotAllowed) : real.read($0) },
                write: { value, account in writes += 1; return real.write(value, account) }) }
            defer { f.close() }
            let server = try await peer(f) { _, response in XCTFail("Keychain failure must prevent HTTP"); response.truncated() }
            defer { server.stop() }
            if blockedAccount == "official.deviceToken" {
                XCTAssertTrue(f.secrets.write("dev_protected_paid_123456", "official.deviceToken"))
                f.defaults.set("dev_older_plaintext_123456", forKey: "official.deviceToken")
            }
            assertFailure(await OfficialAPI.registerIfNeeded(environment: f.environment), code: "credential_unavailable")
            XCTAssertEqual(writes, 0)
            if blockedAccount == "official.deviceToken" {
                XCTAssertEqual(f.secrets.read("official.deviceToken"), .value("dev_protected_paid_123456"))
                XCTAssertEqual(f.defaults.string(forKey: "official.deviceToken"), "dev_older_plaintext_123456")
            }
        }
    }

    func testFailedCredentialWriteKeepsRegistrationAttemptForSameDeviceRetry() async throws {
        var denyWrite = true
        let f = AccountFixture { real in .init(read: real.read, write: { value, account in
            if account == "official.deviceToken", value != nil, denyWrite { return false }
            return real.write(value, account)
        }) }
        defer { f.close() }
        var attempts: [String] = []
        let server = try await peer(f) { request, response in
            let object = try! JSONSerialization.jsonObject(with: request.body) as! [String: Any]
            attempts.append(object["registration_attempt_id"] as! String)
            response.respond(type: "application/json", body: self.body(token: "dev_write_retry_123456"))
        }
        defer { server.stop() }
        assertFailure(await OfficialAPI.registerIfNeeded(environment: f.environment), code: "credential_unavailable")
        XCTAssertEqual(f.secrets.read("official.registrationAttempt"), .value(attempts[0]))
        XCTAssertEqual(f.secrets.read("official.deviceToken"), .missing)
        XCTAssertNil(f.state.value("balanceQuestions"))
        denyWrite = false
        _ = try await OfficialAPI.registerIfNeeded(environment: f.environment).get()
        XCTAssertEqual(attempts, [attempts[0], attempts[0]])
    }

    func testFailedResetPreservesTheCredentialAndMirrorAndSuccessfulResetClearsAllTotals() {
        for blockedAccount in ["official.registrationAttempt", "official.deviceToken"] {
            var denyDelete = false
            let f = AccountFixture { real in .init(read: real.read, write: { value, account in
                if value == nil, account == blockedAccount, denyDelete { return false }
                return real.write(value, account)
            }) }
            defer { f.close() }
            f.seed()
            XCTAssertTrue(f.secrets.write(String(repeating: "a", count: 43), "official.registrationAttempt"))
            denyDelete = true
            XCTAssertFalse(f.state.resetCredential())
            XCTAssertEqual(f.secrets.read("official.deviceToken"), .value("dev_account_original_123456"))
            XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 80)
            XCTAssertEqual(f.state.value("totalQuestions") as? Int, 20)
            denyDelete = false
            XCTAssertTrue(f.state.resetCredential())
            XCTAssertEqual(f.secrets.read("official.deviceToken"), .missing)
            for key in ["balanceQuestions", "balanceVersion", "cliEnabled", "totalQuestions", "totalInputTokens", "totalOutputTokens"] {
                XCTAssertNil(f.state.value(key))
            }
        }
    }

    func testLegacyMigrationAndReopenedMirrorRemainBoundToOriginalDeviceAndService() throws {
        let f = AccountFixture(); defer { f.close() }
        f.defaults.set("dev_legacy_paid_123456", forKey: "official.deviceToken")
        f.defaults.set(123, forKey: "official.balanceQuestions")
        f.defaults.set(true, forKey: "official.cliEnabled")
        let old = try XCTUnwrap(f.state.account)
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 123)
        XCTAssertNil(f.defaults.object(forKey: "official.deviceToken"))
        XCTAssertEqual(f.secrets.read("official.deviceToken"), .value("dev_legacy_paid_123456"))
        let reopened = OfficialAccountState(defaults: f.defaults, secrets: f.secrets, baseURL: { [base = f.base] in base.value })
        XCTAssertEqual(reopened.value("balanceQuestions") as? Int, 123)
        f.base.value = "https://another-service.invalid"
        XCTAssertNil(reopened.value("balanceQuestions"))
        XCTAssertNil(reopened.value("cliEnabled"))
        XCTAssertFalse(f.state.matches(old))
        f.base.value = OfficialAPI.defaultBaseURL
        XCTAssertFalse(f.state.matches(old), "Returning to a service does not revive an observed old request generation")
        XCTAssertEqual(f.state.token, "dev_legacy_paid_123456")
    }

    func testAChangedPersistedBindingInvalidatesAnotherOwnersCachedMirror() throws {
        let f = AccountFixture(); defer { f.close() }
        f.seed()
        let owner = try XCTUnwrap(f.state.account)
        let otherBase = AccountBaseBox(); otherBase.value = "https://different-service.invalid"
        let other = OfficialAccountState(defaults: f.defaults, secrets: f.secrets, baseURL: { otherBase.value })
        XCTAssertTrue(other.applyBalance(900, version: "900"))
        XCTAssertNil(f.state.value("balanceQuestions"), "A persisted mirror written for another host must not leak back")
        XCTAssertFalse(f.state.matches(owner))
        XCTAssertEqual(f.state.token, owner.token)
    }

    func testConcurrentBalanceReceiptsCannotRollbackAndObserverCanReadWithoutDeadlock() async throws {
        let f = AccountFixture(); defer { f.close() }
        f.seed(balance: 300, version: "0")
        let owner = try XCTUnwrap(f.state.account)
        await withTaskGroup(of: Void.self) { group in
            for i in 1...100 {
                group.addTask { f.state.applyBalance(300 - i, version: String(i), account: owner) }
            }
        }
        XCTAssertEqual(f.state.value("balanceQuestions") as? Int, 200)
        XCTAssertEqual(f.state.value("balanceVersion") as? String, "100")
        var observed: Int?
        var state: OfficialAccountState!
        state = OfficialAccountState(defaults: f.defaults, secrets: f.secrets, baseURL: { [base = f.base] in base.value },
                                     onChange: { observed = state.value("balanceQuestions") as? Int })
        XCTAssertTrue(state.applyBalance(190, version: "101"))
        XCTAssertEqual(observed, 190)
    }

    func testPurchaseHandoffCannotOpenAReplacedAccountsURL() async throws {
        let f = AccountFixture(); defer { f.close() }
        let entered = expectation(description: "purchase"); var reply: CaptureHTTPReply?
        let server = try await peer(f) { request, response in
            XCTAssertEqual(request.path, "/v1/purchase-sessions"); reply = response; entered.fulfill()
        }
        defer { server.stop() }
        f.seed()
        let task = Task { try await OfficialAPI.createPurchaseSession(packID: "pack", catalogVersion: "catalog", environment: f.environment) }
        await fulfillment(of: [entered], timeout: 5)
        f.seed("dev_another_buyer_123456")
        reply?.respond(type: "application/json", body: Data(#"{"purchase_url":"https://example.invalid/purchase/private"}"#.utf8))
        do { _ = try await task.value; XCTFail("Old-account handoff must be discarded") }
        catch let error as OfficialAPIError { XCTAssertEqual(error.code, "account_changed") }
    }

    func testCompletedPurchaseHandoffIsRevalidatedAtItsUseAfterAwait() async throws {
        let f = AccountFixture(); defer { f.close() }
        let server = try await peer(f) { _, response in
            response.respond(type: "application/json", body: Data(#"{"purchase_url":"https://example.invalid/purchase/private"}"#.utf8))
        }
        defer { server.stop() }
        f.seed()
        let handoff = try await OfficialAPI.createPurchaseSession(packID: "pack", catalogVersion: "catalog", environment: f.environment)
        XCTAssertTrue(handoff.belongs(to: f.state))
        f.seed("dev_new_purchase_owner_123456")
        XCTAssertFalse(handoff.belongs(to: f.state))
        let unbound = try JSONDecoder().decode(OfficialAPI.PurchaseSessionResponse.self, from: Data(#"{"purchase_url":"https://example.invalid/purchase/private"}"#.utf8))
        XCTAssertFalse(unbound.belongs(to: f.state))
    }

    func testDefaultLiveEnvironmentUpdatesTheGlobalMirrorAndRejectsAnOldCaptureAfterReplacement() async throws {
        guard ProcessInfo.processInfo.environment["NSPI_QA_EPHEMERAL"] == "1" else {
            throw XCTSkip("Run with NSPI_QA_EPHEMERAL=1 to isolate the default global credential namespace")
        }
        let defaults = UserDefaults.standard
        let keys = ["official.baseURL", "official.deviceToken", "official.accountBinding", "official.balanceQuestions", "official.balanceVersion",
                    "official.cliEnabled", "official.credentialRejected", "official.totalQuestions", "official.totalInputTokens", "official.totalOutputTokens"]
        let saved = keys.map { ($0, defaults.object(forKey: $0)) }
        let token = OfficialAPI.deviceToken
        let attempt = KeychainStore.read("official.registrationAttempt")
        defer {
            OfficialAPI.deviceToken = token
            KeychainStore.write(attempt, account: "official.registrationAttempt")
            for (key, value) in saved {
                if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
            }
        }
        let image = FileManager.default.temporaryDirectory.appendingPathComponent("account-live-" + UUID().uuidString + ".jpg")
        try Data("isolated HTTP material".utf8).write(to: image)
        defer { try? FileManager.default.removeItem(at: image) }
        func frame(_ value: [String: Any]) -> Data {
            Data("data: ".utf8) + (try! JSONSerialization.data(withJSONObject: value)) + Data("\n\n".utf8)
        }
        var posts = 0
        let server = try CaptureHTTPServer { request, response in
            XCTAssertEqual(request.headers["authorization"], "Bearer dev_global_original_123456")
            if request.path == "/v1/account" {
                response.respond(type: "application/json", body: self.body(balance: 80, version: "8", cli: true, total: 20))
            } else {
                posts += 1
                response.respond(body: frame(["type": "delta", "text": "FINAL: B"])
                    + frame(["type": "usage", "input_tokens": 2, "output_tokens": 1, "questions_charged": 1,
                             "balance_questions": 79, "balance_version": "9",
                             "account_totals": ["questions": 21, "input_tokens": 202, "output_tokens": 41]])
                    + Data("data: [DONE]\n\n".utf8))
            }
        }
        defaults.set(try await server.start(), forKey: "official.baseURL")
        defer { server.stop() }
        for replace in [false, true] {
            OfficialAPI.deviceToken = "dev_global_original_123456"
            _ = try await OfficialAPI.refreshAccount().get()
            XCTAssertEqual(OfficialAPI.balanceQuestions, 80)
            XCTAssertTrue(OfficialAPI.cliEnabled)
            let done = expectation(description: "live capture \(replace)")
            var success: Bool?
            let task = try XCTUnwrap(OfficialAPI.run(imagePaths: [image.path], prompt: .init(system: "s", task: "t"), onDelta: { _ in
                XCTAssertTrue(Thread.isMainThread)
                if replace {
                    OfficialAPI.deviceToken = "dev_global_replacement_123456"
                    XCTAssertTrue(OfficialAPI.applyBalance(700, version: "70"))
                }
            }, onDone: { ok, _ in XCTAssertTrue(Thread.isMainThread); success = ok; done.fulfill() }))
            await fulfillment(of: [done], timeout: 5)
            await task.value
            XCTAssertEqual(success, !replace)
            XCTAssertEqual(OfficialAPI.balanceQuestions, replace ? 700 : 79)
            XCTAssertEqual(OfficialAPI.totalQuestions, replace ? 0 : 21)
            XCTAssertFalse(OfficialAPI.credentialRejected)
        }
        XCTAssertEqual(posts, 2)
    }
}
