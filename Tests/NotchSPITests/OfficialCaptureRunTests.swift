import XCTest
import Network
@testable import NotchSPI

struct CaptureHTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
}

final class CaptureHTTPReply: @unchecked Sendable {
    private let connection: NWConnection
    private let queue: DispatchQueue
    init(_ connection: NWConnection, queue: DispatchQueue) { self.connection = connection; self.queue = queue }
    func start(status: Int = 200, type: String = "text/event-stream", extra: String = "") {
        let header = "HTTP/1.1 \(status) Test\r\nContent-Type: \(type)\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\(extra)\r\n"
        write(Data(header.utf8))
    }
    func send(_ bytes: Data) {
        guard !bytes.isEmpty else { return }
        write(Data((String(bytes.count, radix: 16) + "\r\n").utf8) + bytes + Data("\r\n".utf8))
    }
    func finish() { write(Data("0\r\n\r\n".utf8), close: true) }
    func truncated() { write(Data(), close: true) }
    func respond(status: Int = 200, type: String = "text/event-stream", body: Data, complete: Bool = true) {
        start(status: status, type: type); send(body)
        if complete { finish() } else { truncated() }
    }
    private func write(_ bytes: Data, close: Bool = false) {
        queue.async { [connection] in
            connection.send(content: bytes, completion: .contentProcessed { error in
                if close || error != nil { connection.cancel() }
            })
        }
    }
}

/// A real loopback peer, with complete request-body parsing and explicit response gates.
/// It never contacts a model, uses application credentials, or opens the UI.
final class CaptureHTTPServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "test.official-capture.http")
    private var connections: [NWConnection] = []
    private let handler: @MainActor (CaptureHTTPRequest, CaptureHTTPReply) -> Void
    init(handler: @escaping @MainActor (CaptureHTTPRequest, CaptureHTTPReply) -> Void) throws {
        self.handler = handler
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }
    func start() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.listener.stateUpdateHandler = nil
                    guard let port = self.listener.port else { continuation.resume(throwing: URLError(.cannotConnectToHost)); return }
                    continuation.resume(returning: "http://127.0.0.1:\(port.rawValue)")
                case .failed(let error): self.listener.stateUpdateHandler = nil; continuation.resume(throwing: error)
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { connection.cancel(); return }
                self.connections.append(connection); connection.start(queue: self.queue)
                self.receive(connection, accumulated: Data())
            }
            listener.start(queue: queue)
        }
    }
    private func receive(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] bytes, _, ended, error in
            guard let self, error == nil, let bytes else { connection.cancel(); return }
            let data = accumulated + bytes
            guard data.count <= 13 * 1024 * 1024 else { connection.cancel(); return }
            if let separator = data.range(of: Data("\r\n\r\n".utf8)) {
                let lines = String(decoding: data[..<separator.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                let first = (lines.first ?? "").split(separator: " ")
                guard first.count == 3 else { connection.cancel(); return }
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":") else { continue }
                    headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                }
                let length = Int(headers["content-length"] ?? "0") ?? -1
                guard length >= 0, length <= 12 * 1024 * 1024 else { connection.cancel(); return }
                if data.count >= separator.upperBound + length {
                    let request = CaptureHTTPRequest(method: String(first[0]), path: String(first[1]), headers: headers,
                        body: Data(data[separator.upperBound..<(separator.upperBound + length)]))
                    let reply = CaptureHTTPReply(connection, queue: self.queue)
                    Task { @MainActor in self.handler(request, reply) }
                    return
                }
            }
            if ended { connection.cancel() } else { self.receive(connection, accumulated: data) }
        }
    }
    func stop() {
        queue.sync {
            listener.newConnectionHandler = nil; listener.stateUpdateHandler = nil
            connections.forEach { $0.cancel() }; connections.removeAll(); listener.cancel()
        }
    }
}

private final class CaptureAccountBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: OfficialAPI.CaptureAccount?
    var value: OfficialAPI.CaptureAccount? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

@MainActor
private final class CaptureRunFixture {
    let account = CaptureAccountBox()
    let session = URLSession(configuration: .ephemeral)
    let root: URL
    let paths: [String]
    let id = UUID()
    var requests: [CaptureHTTPRequest] = []
    var deltas: [String] = []
    var receipts: [OfficialUsageReceipt] = []
    var settlements: [SettlementSnapshot] = []
    var completions: [(Bool, String)] = []
    var callbackOrder: [String] = []
    var rejected = 0
    var onReceipt: (() -> Void)?
    var onDelta: (() -> Void)?
    init() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("official-run-" + UUID().uuidString)
        root = directory
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        paths = ["reference", "question"].map { directory.appendingPathComponent($0 + ".jpg").path }
        // Deliberately identifiable bytes test the file-to-HTTP ordering contract. Image
        // validity is covered separately by actual JPEG/PNG decoder tests on the server.
        for (index, path) in paths.enumerated() { try Data("material-\(index)".utf8).write(to: URL(fileURLWithPath: path)) }
    }
    var environment: OfficialAPI.CaptureEnvironment {
        .init(session: session, account: { [account] in account.value }, receiveUsage: { [self] receipt in
            XCTAssertTrue(Thread.isMainThread); receipts.append(receipt); callbackOrder.append("usage"); onReceipt?()
        }, receiveSettlement: { [self] status in
            XCTAssertTrue(Thread.isMainThread); settlements.append(status); callbackOrder.append("status")
        }, rejectCredential: { [self] in XCTAssertTrue(Thread.isMainThread); rejected += 1 })
    }
    func run(legacy: Bool = false, auxiliary: AuxiliaryCaptureRequest? = nil, images: [String]? = nil,
             onUsage: ((OfficialUsageReceipt) -> Void)? = nil) throws -> Task<Void, Never> {
        try XCTUnwrap(OfficialAPI.run(imagePaths: images ?? paths, prompt: .init(system: "system", task: "task"),
            resultProtocol: legacy ? nil : "objective_v1", captureID: id,
            screenQuery: legacy ? nil : .init(profileID: "reading_practice", language: "en", parentCaptureID: nil),
            auxiliary: auxiliary, environment: environment, onUsage: onUsage,
            onDelta: { [self] text in XCTAssertTrue(Thread.isMainThread); deltas.append(text); callbackOrder.append("delta"); onDelta?() },
            onDone: { [self] ok, message in XCTAssertTrue(Thread.isMainThread); completions.append((ok, message)); callbackOrder.append("done") }))
    }
    func snapshot(operation: String = "solve", charged: Int = 1, state: String? = nil) -> [String: Any] {
        ["capture_id": id.uuidString.lowercased(), "operation": operation,
         "terminal_state": state ?? (charged == 1 || operation != "solve" ? "usable" : "failed"),
         "settlement_status": operation != "solve" ? "not_required" : charged == 1 ? "settled" : "released",
         "questions_charged": charged, "usable_result": charged == 1 || operation != "solve",
         "balance_questions": 29, "held_questions": 0, "balance_version": "3", "can_retry": charged == 0, "can_recover": charged == 1]
    }
    func frame(_ value: [String: Any]) throws -> Data {
        Data("data: ".utf8) + (try JSONSerialization.data(withJSONObject: value)) + Data("\n\n".utf8)
    }
    func usage(operation: String = "solve", legacy: Bool = false) throws -> Data {
        var value = legacy ? [:] : snapshot(operation: operation, charged: operation == "solve" ? 1 : 0)
        value.merge(["type": "usage", "input_tokens": 2, "output_tokens": 1,
                     "questions_charged": operation == "solve" ? 1 : 0, "balance_questions": 29]) { _, new in new }
        return try frame(value)
    }
    func answer(operation: String = "solve", done: Bool = true, legacy: Bool = false) throws -> Data {
        try frame(["type": "delta", "text": "中文 🔎 FINAL: B"]) + usage(operation: operation, legacy: legacy)
            + Data((done ? "data: [DONE]\n\n" : "").utf8)
    }
    func cleanup() { onDelta = nil; onReceipt = nil; session.invalidateAndCancel(); try? FileManager.default.removeItem(at: root) }
}

@MainActor
final class OfficialCaptureRunTests: XCTestCase {
    private func connect(_ fixture: CaptureRunFixture,
        handler: @escaping @MainActor (CaptureHTTPRequest, CaptureHTTPReply) -> Void) async throws -> CaptureHTTPServer {
        let server = try CaptureHTTPServer { request, reply in fixture.requests.append(request); handler(request, reply) }
        fixture.account.value = .init(token: "dev_isolated_test", baseURL: try await server.start())
        return server
    }
    private func finish(_ task: Task<Void, Never>, fixture: CaptureRunFixture) async {
        let done = expectation(description: "capture handler completed")
        Task { await task.value; done.fulfill() }
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(fixture.completions.count, 1)
    }

    func testCompleteRunReadsFilesBuildsBoundRequestAndDeliversExactlyOnceOnMainThread() async throws {
        let f = try CaptureRunFixture(), payload = try f.answer()
        let server = try await connect(f) { _, reply in reply.respond(body: payload) }
        defer { server.stop(); f.cleanup() }
        await finish(try f.run(), fixture: f)
        XCTAssertEqual(f.completions.first?.0, true); XCTAssertEqual(f.callbackOrder, ["delta", "usage", "done"])
        XCTAssertEqual(f.deltas.joined(), "中文 🔎 FINAL: B"); XCTAssertEqual(f.receipts.count, 1); XCTAssertTrue(f.settlements.isEmpty)
        let request = try XCTUnwrap(f.requests.first), body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(f.requests.count, 1); XCTAssertEqual(request.method, "POST"); XCTAssertEqual(request.path, "/v1/captures")
        XCTAssertEqual(request.headers["authorization"], "Bearer dev_isolated_test")
        XCTAssertEqual(body["capture_id"] as? String, f.id.uuidString.lowercased())
        XCTAssertEqual(body["image_base64"] as? String, Data("material-1".utf8).base64EncodedString())
        XCTAssertEqual(body["images_base64"] as? [String], ["material-0", "material-1"].map { Data($0.utf8).base64EncodedString() })
        XCTAssertEqual(body["response_contract"] as? String, "screen_query_v1")
        XCTAssertEqual((body["scope"] as? [String: Any])?["question_image_index"] as? Int, 1)
    }

    func testRecoveredAnswerExplanationKeepsTheBilledParentAndExplicitAnswerIdentity() async throws {
        let f = try CaptureRunFixture(), parent = UUID(), recovery = UUID()
        let payload = try f.answer(operation: "explain")
        let server = try await connect(f) { _, reply in reply.respond(body: payload) }
        defer { server.stop(); f.cleanup() }
        await finish(try f.run(auxiliary: .init(parentID: parent, operation: "explain", finalAnswer: "C", answerCaptureID: recovery)), fixture: f)
        XCTAssertEqual(f.completions.first?.0, true)
        let request = try XCTUnwrap(f.requests.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(request.path, "/v1/captures/" + parent.uuidString.lowercased() + "/explanation")
        XCTAssertEqual(body["answer_capture_id"] as? String, recovery.uuidString.lowercased())
        XCTAssertEqual(body["explanation_id"] as? String, f.id.uuidString.lowercased())
        XCTAssertEqual(body["final_answer"] as? String, "C")
        XCTAssertEqual(body["images_base64"] as? [String], ["material-0", "material-1"].map { Data($0.utf8).base64EncodedString() })
        XCTAssertEqual(f.requests.count, 1)
    }

    func testDeploymentOversizeMaterialsNeverStartSolveLegacyExplanationOrRecoveryHTTP() async throws {
        for operation in ["legacy", "solve", "explain", "recover"] {
            let f = try CaptureRunFixture()
            let payload = try f.answer(operation: operation == "legacy" ? "solve" : operation)
            let server = try await connect(f) { _, reply in reply.respond(body: payload) }
            defer { server.stop(); f.cleanup() }
            for path in f.paths { try Data(repeating: 65, count: 1_200_000).write(to: URL(fileURLWithPath: path)) }
            let auxiliary: AuxiliaryCaptureRequest? = ["explain", "recover"].contains(operation)
                ? .init(parentID: UUID(), operation: operation, finalAnswer: operation == "explain" ? "B" : nil) : nil
            await finish(try f.run(legacy: operation == "legacy", auxiliary: auxiliary), fixture: f)
            XCTAssertFalse(f.completions.first?.0 ?? true, operation)
            XCTAssertTrue(f.requests.isEmpty, "Oversize \(operation) must stop before any HTTP or status request")
            XCTAssertTrue(f.receipts.isEmpty); XCTAssertTrue(f.settlements.isEmpty)
        }
    }

    func testFourOriginalMaterialsFitBelowDeploymentLimitWithoutJSONSlashExpansion() async throws {
        let f = try CaptureRunFixture(), payload = try f.answer()
        let server = try await connect(f) { _, reply in reply.respond(body: payload) }
        defer { server.stop(); f.cleanup() }
        var originals: [Data] = []
        let paths = try (0..<4).map { index -> String in
            var bytes = Data(repeating: 255, count: 550_000); bytes[0] = UInt8(index)
            originals.append(bytes)
            let file = f.root.appendingPathComponent("page-\(index).jpg"); try bytes.write(to: file); return file.path
        }
        await finish(try f.run(images: paths), fixture: f)
        XCTAssertEqual(f.completions.first?.0, true)
        let request = try XCTUnwrap(f.requests.first)
        XCTAssertLessThanOrEqual(request.body.count, 4 * 1024 * 1024)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(json["images_base64"] as? [String], originals.map { $0.base64EncodedString() })
        XCTAssertEqual(json["image_base64"] as? String, originals.last?.base64EncodedString())
        XCTAssertEqual((json["scope"] as? [String: Any])?["question_image_index"] as? Int, 3)
    }

    func testPlatform413UsesCaptureGuidanceWithoutRetryOrSettlementLookup() async throws {
        let f = try CaptureRunFixture()
        let server = try await connect(f) { _, reply in
            reply.respond(status: 413, type: "text/plain", body: Data("FUNCTION_PAYLOAD_TOO_LARGE".utf8))
        }
        defer { server.stop(); f.cleanup() }
        await finish(try f.run(), fixture: f)
        XCTAssertEqual(f.completions.first?.0, false)
        XCTAssertEqual(f.completions.first?.1, OfficialAPI.localizedMessage(code: "payload_too_large", fallback: ""))
        XCTAssertEqual(f.requests.count, 1); XCTAssertEqual(f.requests.first?.method, "POST")
        XCTAssertTrue(f.receipts.isEmpty); XCTAssertTrue(f.settlements.isEmpty)
    }

    func testFinalJSONEnvelopeIsCountedAfterAnImageFitsTheEncodingBudget() async throws {
        let f = try CaptureRunFixture(), payload = try f.answer()
        let server = try await connect(f) { _, reply in reply.respond(body: payload) }
        defer { server.stop(); f.cleanup() }
        try Data(repeating: 65, count: OfficialCaptureMaterials.imageLimit).write(to: URL(fileURLWithPath: f.paths[0]))
        XCTAssertEqual(try OfficialCaptureMaterials.load([f.paths[0]])[0].utf8.count, 4 * 1024 * 1024)
        await finish(try f.run(images: [f.paths[0]]), fixture: f)
        XCTAssertEqual(f.completions.first?.0, false)
        XCTAssertTrue(f.requests.isEmpty); XCTAssertTrue(f.receipts.isEmpty); XCTAssertTrue(f.settlements.isEmpty)
    }

    func testExplanationCapabilityCallbackRemainsSeparateFromCompleteAnswerDelivery() async throws {
        for done in [false, true] {
            let f = try CaptureRunFixture()
            var receipt = f.snapshot(operation: "recover", charged: 0)
            receipt.merge(["type": "usage", "input_tokens": 5, "output_tokens": 3, "explanation_available": true]) { _, new in new }
            let payload = try f.frame(["type": "delta", "text": "FINAL: C"]) + f.frame(receipt)
                + Data((done ? "data: [DONE]\n\n" : "").utf8)
            let status = try JSONSerialization.data(withJSONObject: f.snapshot(operation: "recover", charged: 0))
            let server = try await connect(f) { request, reply in
                if request.method == "POST" { reply.respond(body: payload, complete: done) }
                else { reply.respond(type: "application/json", body: status) }
            }
            defer { server.stop(); f.cleanup() }
            var capabilities: [Bool] = []
            await finish(try f.run(auxiliary: .init(parentID: UUID(), operation: "recover", finalAnswer: nil), onUsage: { value in
                XCTAssertTrue(Thread.isMainThread)
                capabilities.append(value.explanationAvailable == true)
            }), fixture: f)
            XCTAssertEqual(capabilities, [true])
            XCTAssertEqual(f.completions.first?.0, done, "A capability receipt alone does not prove answer delivery")
        }
    }

    func testAccountReplacementInsideMirrorCallbackCannotDeliverAnOldCapability() async throws {
        let f = try CaptureRunFixture(), payload = try f.answer()
        let server = try await connect(f) { _, reply in reply.respond(body: payload) }
        defer { server.stop(); f.cleanup() }
        f.onReceipt = { f.account.value = .init(token: "dev_changed_in_mirror", baseURL: f.account.value!.baseURL) }
        var delivered = false
        await finish(try f.run(onUsage: { _ in delivered = true }), fixture: f)
        XCTAssertFalse(delivered)
        XCTAssertEqual(f.completions.first?.0, false)
    }

    func testTruncatedReceiptReconcilesOriginalIDWithoutRepostingOrCompletingAnswer() async throws {
        let f = try CaptureRunFixture(), partial = try f.answer(done: false), status = try JSONSerialization.data(withJSONObject: f.snapshot())
        let server = try await connect(f) { request, reply in
            if request.method == "POST" { reply.respond(body: partial, complete: false) }
            else { reply.respond(type: "application/json", body: status) }
        }
        defer { server.stop(); f.cleanup() }
        await finish(try f.run(), fixture: f)
        XCTAssertEqual(f.completions.first?.0, false); XCTAssertEqual(f.receipts.count, 1); XCTAssertEqual(f.settlements.count, 1)
        XCTAssertEqual(f.requests.map(\.method), ["POST", "GET"])
        XCTAssertEqual(f.requests.last?.path, "/v1/captures/\(f.id.uuidString.lowercased())/status")
        XCTAssertEqual(f.settlements.first?.questionsCharged, 1)
    }

    func testConflictReadsOnlyOriginalStatusAndNeverReconstructsAnAnswer() async throws {
        let f = try CaptureRunFixture(), status = try JSONSerialization.data(withJSONObject: f.snapshot())
        let server = try await connect(f) { request, reply in
            if request.method == "POST" { reply.respond(status: 409, type: "application/json", body: Data("{\"error\":{\"code\":\"capture_already_finalized\"}}".utf8)) }
            else { reply.respond(type: "application/json", body: status) }
        }
        defer { server.stop(); f.cleanup() }
        await finish(try f.run(), fixture: f)
        XCTAssertEqual(f.completions.first?.0, false); XCTAssertTrue(f.deltas.isEmpty); XCTAssertTrue(f.receipts.isEmpty)
        XCTAssertEqual(f.settlements.count, 1); XCTAssertEqual(f.requests.map(\.method), ["POST", "GET"])
    }

    func testCurrent401FlagsRejectionWithoutChangingCredentialOrReposting() async throws {
        let f = try CaptureRunFixture()
        let server = try await connect(f) { _, reply in reply.respond(status: 401, type: "application/json", body: Data("{}".utf8)) }
        defer { server.stop(); f.cleanup() }
        let identity = f.account.value
        await finish(try f.run(), fixture: f)
        XCTAssertEqual(f.account.value, identity); XCTAssertEqual(f.rejected, 1); XCTAssertEqual(f.requests.count, 1)
        XCTAssertEqual(f.completions.first?.0, false)
    }

    func testDelayed401FromReplacedAccountDoesNotRejectCurrentCredential() async throws {
        let f = try CaptureRunFixture(), entered = expectation(description: "POST reached peer")
        var pending: CaptureHTTPReply?
        let server = try await connect(f) { _, reply in pending = reply; entered.fulfill() }
        defer { server.stop(); f.cleanup() }
        let task = try f.run(); await fulfillment(of: [entered], timeout: 5)
        f.account.value = .init(token: "dev_replacement", baseURL: f.account.value!.baseURL)
        pending?.respond(status: 401, type: "application/json", body: Data("{}".utf8))
        await finish(task, fixture: f)
        XCTAssertEqual(f.rejected, 0); XCTAssertTrue(f.settlements.isEmpty); XCTAssertEqual(f.completions.first?.0, false)
    }

    func testAccountAndHostChangesSuppressBufferedDeltasUsageAndReconciliation() async throws {
        for changeHost in [false, true] {
            let f = try CaptureRunFixture(), entered = expectation(description: "paused POST"), data = try f.answer()
            var pending: CaptureHTTPReply?
            let server = try await connect(f) { _, reply in pending = reply; entered.fulfill() }
            defer { server.stop(); f.cleanup() }
            let task = try f.run(); await fulfillment(of: [entered], timeout: 5)
            let previous = try XCTUnwrap(f.account.value)
            f.account.value = .init(token: changeHost ? previous.token : "dev_new", baseURL: changeHost ? previous.baseURL + "/new" : previous.baseURL)
            pending?.respond(body: data); await finish(task, fixture: f)
            XCTAssertTrue(f.deltas.isEmpty); XCTAssertTrue(f.receipts.isEmpty); XCTAssertTrue(f.settlements.isEmpty)
            XCTAssertEqual(f.completions.first?.0, false); XCTAssertEqual(f.requests.count, 1)
        }
    }

    func testAccountSwitchInsideReceiptCallbackCannotProduceSuccessfulCompletion() async throws {
        let f = try CaptureRunFixture(), data = try f.answer()
        let server = try await connect(f) { _, reply in reply.respond(body: data) }
        defer { server.stop(); f.cleanup() }
        f.onReceipt = { f.account.value = .init(token: "dev_new", baseURL: f.account.value!.baseURL) }
        await finish(try f.run(), fixture: f)
        XCTAssertEqual(f.receipts.count, 1); XCTAssertEqual(f.completions.first?.0, false)
        XCTAssertEqual(f.requests.count, 1); XCTAssertTrue(f.settlements.isEmpty)
    }

    func testImmediateCancellationMakesNoHTTPRequest() async throws {
        let f = try CaptureRunFixture()
        let server = try await connect(f) { _, reply in reply.respond(status: 500, body: Data()) }
        defer { server.stop(); f.cleanup() }
        let task = try f.run(); task.cancel(); await finish(task, fixture: f)
        XCTAssertTrue(f.requests.isEmpty); XCTAssertTrue(f.deltas.isEmpty); XCTAssertEqual(f.completions.first?.0, false)
    }

    func testCancellationAfterDeltaDiscardsBufferedReceiptAndDoesNotQueryStatus() async throws {
        let f = try CaptureRunFixture(), data = try f.answer()
        let server = try await connect(f) { _, reply in reply.respond(body: data) }
        defer { server.stop(); f.cleanup() }
        var task: Task<Void, Never>?
        f.onDelta = { task?.cancel() }; task = try f.run()
        await finish(try XCTUnwrap(task), fixture: f)
        XCTAssertEqual(f.deltas.count, 1); XCTAssertTrue(f.receipts.isEmpty); XCTAssertTrue(f.settlements.isEmpty)
        XCTAssertEqual(f.completions.first?.0, false); XCTAssertEqual(f.requests.count, 1)
    }

    func testCancellationAndAccountReplacementWhileStatusWaitsCannotApplyItsBalance() async throws {
        for cancel in [false, true] {
            let f = try CaptureRunFixture(), entered = expectation(description: "status reached peer")
            var pending: CaptureHTTPReply?
            let status = try JSONSerialization.data(withJSONObject: f.snapshot())
            let server = try await connect(f) { request, reply in
                if request.method == "POST" { reply.respond(body: Data(), complete: false) }
                else { pending = reply; entered.fulfill() }
            }
            defer { server.stop(); f.cleanup() }
            let task = try f.run(); await fulfillment(of: [entered], timeout: 5)
            if cancel { task.cancel() } else { f.account.value = .init(token: "dev_new", baseURL: f.account.value!.baseURL) }
            pending?.respond(type: "application/json", body: status)
            await finish(task, fixture: f)
            XCTAssertTrue(f.settlements.isEmpty); XCTAssertTrue(f.receipts.isEmpty); XCTAssertEqual(f.completions.first?.0, false)
            XCTAssertEqual(f.requests.map(\.method), ["POST", "GET"])
        }
    }

    func testStatusValidationRejectsWrongBindingInvalidStateAndOversizedBodies() async throws {
        for variant in ["id", "operation", "missing_operation", "balance", "pending", "html", "json", "oversized"] {
            let f = try CaptureRunFixture()
            var object = f.snapshot()
            switch variant {
            case "id": object["capture_id"] = UUID().uuidString
            case "operation": object["operation"] = "recover"
            case "missing_operation": object.removeValue(forKey: "operation")
            case "balance": object["balance_questions"] = -1
            case "pending": object["terminal_state"] = "pending"; object["settlement_status"] = "held"; object["questions_charged"] = NSNull()
            default: break
            }
            var data = try JSONSerialization.data(withJSONObject: object)
            if variant == "oversized" { data.append(Data(repeating: 32, count: 65_537)) }
            if variant == "json" { data = Data("{".utf8) }
            let payload = data
            let server = try await connect(f) { request, reply in
                if request.method == "POST" { reply.respond(body: Data(), complete: false) }
                else { reply.respond(type: variant == "html" ? "text/html" : "application/json", body: payload) }
            }
            defer { server.stop(); f.cleanup() }
            await finish(try f.run(), fixture: f)
            XCTAssertTrue(f.settlements.isEmpty, variant); XCTAssertEqual(f.completions.first?.0, false, variant)
            XCTAssertEqual(f.requests.map(\.method), ["POST", "GET"], variant)
        }
    }

    func testReleasedStatusRestoresBillingWithoutPretendingAnAnswerWasDelivered() async throws {
        let f = try CaptureRunFixture(), status = try JSONSerialization.data(withJSONObject: f.snapshot(charged: 0))
        let server = try await connect(f) { request, reply in
            reply.respond(type: request.method == "GET" ? "application/json" : "text/event-stream", body: request.method == "GET" ? status : Data())
        }
        defer { server.stop(); f.cleanup() }
        await finish(try f.run(), fixture: f)
        XCTAssertEqual(f.settlements.first?.questionsCharged, 0); XCTAssertEqual(f.completions.first?.0, false)
        XCTAssertTrue(f.receipts.isEmpty); XCTAssertEqual(f.requests.map(\.method), ["POST", "GET"])
    }

    func testLegacyAndAuxiliaryRoutesUseTheSameVerifiedTransport() async throws {
        for operation in ["legacy", "explain", "recover"] {
            let f = try CaptureRunFixture(), parent = UUID(), legacy = operation == "legacy"
            let data = try f.answer(operation: legacy ? "solve" : operation, legacy: legacy)
            let server = try await connect(f) { _, reply in reply.respond(body: data) }
            defer { server.stop(); f.cleanup() }
            await finish(try f.run(legacy: legacy, auxiliary: legacy ? nil : .init(parentID: parent, operation: operation, finalAnswer: operation == "explain" ? "B" : nil)), fixture: f)
            XCTAssertEqual(f.completions.first?.0, true, operation); XCTAssertEqual(f.receipts.count, 1)
            XCTAssertEqual(f.receipts.first?.questionsCharged, legacy ? 1 : 0)
            let request = try XCTUnwrap(f.requests.first), payload = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
            if legacy { XCTAssertEqual(request.path, "/v1/captures"); XCTAssertNil(payload["response_contract"]) }
            else {
                XCTAssertEqual(request.path, "/v1/captures/\(parent.uuidString.lowercased())/\(operation == "explain" ? "explanation" : "recovery")")
                XCTAssertEqual(payload[operation == "explain" ? "explanation_id" : "recovery_id"] as? String, f.id.uuidString.lowercased())
                XCTAssertEqual(payload["final_answer"] as? String, operation == "explain" ? "B" : nil)
            }
        }
    }

    func testMissingAndOversizedMaterialsFailBeforeAnyNetworkRequest() async throws {
        for variant in ["empty", "missing", "oversized"] {
            let f = try CaptureRunFixture()
            let server = try await connect(f) { _, reply in reply.respond(status: 500, body: Data()) }
            defer { server.stop(); f.cleanup() }
            if variant == "oversized" { try Data(repeating: 65, count: 10 * 1024 * 1024).write(to: URL(fileURLWithPath: f.paths[0])) }
            let paths = variant == "empty" ? [] : variant == "missing" ? [f.root.appendingPathComponent("absent.jpg").path] : [f.paths[0]]
            await finish(try f.run(images: paths), fixture: f)
            XCTAssertTrue(f.requests.isEmpty, variant); XCTAssertEqual(f.completions.first?.0, false, variant)
        }
    }

    func testMissingCredentialCompletesOnceWithoutCreatingTaskOrSendingRequest() async throws {
        let f = try CaptureRunFixture(), done = expectation(description: "missing credential callback")
        let server = try await connect(f) { _, reply in reply.respond(status: 500, body: Data()) }
        defer { server.stop(); f.cleanup() }
        f.account.value = nil
        var count = 0
        let task = OfficialAPI.run(imagePaths: f.paths, prompt: .init(system: "s", task: "t"), environment: f.environment,
            onDelta: { _ in XCTFail("Unexpected delta") }, onDone: { ok, _ in
                XCTAssertTrue(Thread.isMainThread); XCTAssertFalse(ok); count += 1; done.fulfill()
            })
        XCTAssertNil(task); await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(count, 1); XCTAssertTrue(f.requests.isEmpty)
    }

    func testInvalidAuxiliaryNegotiationCannotStartARecoveryByDefault() async throws {
        for legacy in [false, true] {
            let f = try CaptureRunFixture()
            let server = try await connect(f) { _, reply in reply.respond(status: 500, body: Data()) }
            defer { server.stop(); f.cleanup() }
            await finish(try f.run(legacy: legacy, auxiliary: .init(parentID: UUID(), operation: legacy ? "explain" : "unsupported", finalAnswer: "B")), fixture: f)
            XCTAssertEqual(f.completions.first?.0, false); XCTAssertTrue(f.requests.isEmpty)
        }
    }
}
